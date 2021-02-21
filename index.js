"use strict";

const express = require("express");
const app = express();

const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
const pageProxy = require("puppeteer-page-proxy");

var Mutex = require("async-mutex").Mutex;
const mutex = new Mutex();

const got = require("got");

const IANACodes = require("./lib/iana.json");

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

app.get("/fetch", async (inbound_request, res) => {
    console.log(`received a request for ${inbound_request.query.url}`);
    
    // initialize "globals"
    let page;
    
    const payload = {
        body: "",
        cookies: "",
        status_code: -1,
        status_text: "",
        requested_url: inbound_request.query.url,
        resolved_url: "",
        error:  "",
    };
    
    let num = 0;
    
    try {
        page = await browser.newPage();
        
        await page.setRequestInterception(true);
        
        
        page.on("request", async request => {
            if (!["document", "script", "xhr", "fetch"].includes(request.resourceType())) {
                request.abort();
                return;
            }
            
            // console.log(`fetching ${request.url()}`);
            
            await mutex.runExclusive(async () => {
                num += 1;
            });
            
            if (isValidHttpUrl(inbound_request.query.proxy)) {
                
                // console.log(`proxying request for ${req.url()} to ${req.query.proxy}`);
                
                try {
                    await pageProxy(request, inbound_request.query.proxy);
                } catch (err) {
                    console.log(`proxied request to ${request.url()} failed: ${err}`, err);
                    request.abort();
                }
                return
            };
            
            const options = {
                method: request.method(),
                body: request.postData(),
                headers: request.headers(),
                responseType: "buffer",
                maxRedirects: 15,
                throwHttpErrors: false,
                ignoreInvalidCookies: true,
                followRedirect: false,
                timeout: 1*45*1000, // 45 second initial timeout
                retry: 1,
            };
            let response
            
            try {
                response = await got(request.url(), options); 
            } catch (err) {
                if (request.url() !== inbound_request.query.url) {
                    console.log(`auxiliary request to ${request.url()} failed: ${err}`);
                } else {
                    console.log(`request to ${request.url()} failed: ${err}`); 
                }
                request.abort();
                return
            }
            
            // TODO: Revisit after https://github.com/puppeteer/puppeteer/issues/6913 resolves
            let code = response.statusCode;
            if (!(response.statusCode.toString() in IANACodes)) {
                const ds = Object.keys(IANACodes).map(x=> Math.abs(parseInt(x)-code));
                // [JRR] https://stackoverflow.com/questions/11301438/return-index-of-greatest-value-in-an-array
                const closest = ds.indexOf(Math.min(...ds))
                const n_code = parseInt(Object.keys(IANACodes)[closest.toString()])                    
                console.log(`replacing incompatible code ${code} with ${n_code}`)
                code = n_code
            }
            
            // TODO: Think about how to deal with possible exceptions here in a good way
            await request.respond({
                status: code,
                headers: response.headers,
                body: response.body,
            });
            
        })
        
        let response = await page.goto(inbound_request.query.url,
            {
                timeout: 10 * 60 * 1000, // 10m
                waitUntil: ["load", "domcontentloaded", "networkidle0", "networkidle2",],
            });
                        
            // response
            payload.status_code = response?.status();
            payload.status_text = response?.statusText();
            payload.resolved_url = response?.url(); // If there's no response then this is null
            
            // 200-like status
            if (!response?.ok()) {
                console.log(`${inbound_request.query.url} was unhealthy => status: ${response?.status()}, response: ${response?.statusText()}`);
            }
            
            if (inbound_request.query.cookies === "true") {
                payload.cookies = await page.cookies();
            }
            
            let body = await response?.buffer();
            // TODO: remove, TESTING
            if (is_log_memory) {
                memory_consumed += body.length;
            }
            
            payload.body = body.toString();
            res.status(200);
            res.set("content-type", "text/json");
        } catch (e) {
            res.status(500);
            payload.error = e.toString();
        } finally {
            res.json(payload); // payload.error is non-null if catch
            res.end();
            if (!payload.error) {
                console.log(`succeeded: page visit to ${inbound_request.query.url}`);
            } else {
                console.log(`failed: page visit to ${inbound_request.query.url}: ${payload.error}`);
            }
            
            // TODO: remove, TESTING
            if (is_log_memory) {
                console.log(`processed ${(memory_consumed >> 20)} MiB (${memory_consumed} bytes) so far`);
            }
            
            page.close().catch((e) => { console.log(`failed to close page for ${inbound_request.query.url}: ${e}`); });
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