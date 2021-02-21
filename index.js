"use strict";

const express = require("express");

const app = express();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());

const pageProxy = require("puppeteer-page-proxy");

var Mutex = require("async-mutex").Mutex;

const mutex = new Mutex();

let browser;

async function init() {
    browser = await puppeteer.launch({
        headless: true,
        ignoreHTTPSErrors: true,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-sync",
            "--ignore-certificate-errors",
            "--lang=en-US,en;q=0.9",
        ],
        defaultViewport: {width:1366, height:768},
    });
}

// TODO: remove, TESTING
let memory_consumed;
let is_log_memory;
// keep track of cumulative memory allocated
if (process.argv.length > 2) {
    is_log_memory = true;
    memory_consumed = 0; // initialize
}

app.get("/fetch", async (req, res) => {
    console.log(`received a request for ${req.query.url}`);

    // initialize "globals"
    let page;

    const payload = {
        html: "",
        cookies: "",
        statusCode: -1,
        statusText: "",
        requested_url: req.query.url,
        resolved_url: "",
        error: "",
    };

    let num = 0;

    try {
        page = await browser.newPage();

        if (isValidHttpUrl(req.query.proxy)) {
            await page.setRequestInterception(true);
            console.log("proxying to ", req.query.proxy);

            page.on("request", async request => {
                if (!["document", "script", "xhr", "fetch"].includes(request.resourceType())) {
                    request.abort();
                    return;
                }

                console.log(`fetching ${request.url()}`);


                await mutex.runExclusive(async () => {
                    num += 1;
                });

                try {
                    await pageProxy(request, req.query.proxy);
                } catch (e) {
                    console.log(`request to ${request.url()} failed: ${e}`);
                    request.abort();
                }
            });
        }

        let response = await page.goto(req.query.url,
            {
                timeout: 5 * 60 * 1000, // 5m
                waitUntil: ["load", "domcontentloaded", "networkidle0", "networkidle2",],
            });

        console.log(`\nmade ${num} requests!!!\n`);

        // response
        payload.resolved_url = response.url();
        payload.statusCode = response.status();
        payload.statusText = response.statusText();

        // 200-like status
        if (!response.ok()) {
            throw `errored response: ${req.query.url} returned ${response.status()}, ${response.statusText()}`;
        }


        if (req.query.cookies === "true") {
            payload.cookies = await page.cookies();
        }

        let content = await page.content();
        // TODO: remove, TESTING
        if (is_log_memory) {
            memory_consumed += content.length;
        }

        payload.html = content;
        res.status(200);
        res.set("content-type", "text/json");
    } catch (e) {
        res.status(500);
        payload.error = e;
    } finally {
        res.json(payload); // payload.error is non-null if catch
        res.end();
        if (!payload.error) {
            console.log(`successfully processed ${req.query.url}`);
        } else {
            console.log(`${req.method} request to ${req.query.url} failed: ${payload.error}`);
        }

        // TODO: remove, TESTING
        if (is_log_memory) {
            console.log(`processed ${(memory_consumed >> 20)} MiB (${memory_consumed} bytes) so far`);
        }

        page.close().catch((e) => { console.log(`failed to close page for ${req.query.url}: ${e}`); });

        // setTimeout(() => page.close().catch((e) => { console.log(`failed to close page for ${req.query.url}: ${e}`); }),10000);
    }
});

app.listen(8000, async () => {
    await init(); // initialize the browser
    // TODO: remove, TESTING
    if (is_log_memory) {
        console.log("logging memory");
    } else {
        console.log("not logging memory");
    }

    console.log(`listening on port 8000 (${process.pid})`);

    // Here we send the ready signal to PM2
    if (process.send) {
        process.send("ready");
    }
});

// [JRR]: https://stackoverflow.com/questions/5717093/check-if-a-javascript-string-is-a-url
function isValidHttpUrl(string) {
    let url;

    try {
        url = new URL(string);
    } catch (_) {
        return false;
    }

    return url.protocol === "http:" || url.protocol === "https:";
}