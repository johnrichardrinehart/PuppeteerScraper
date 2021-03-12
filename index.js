"use strict";

// Web server
const express = require("express");
const app = express();
// Web browser
const puppeteer = require("puppeteer-extra");
const StealthPlugin = require("puppeteer-extra-plugin-stealth");
puppeteer.use(StealthPlugin());
// HTTP Proxy Agent support
const pageProxy = require("puppeteer-page-proxy");
// Logging
const winston = require("winston");

const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({level: "debug"}),
    ],
});

// TODO: remove, TESTING
let memory_consumed;
let is_log_memory;
// keep track of cumulative memory allocated
if (process.argv.length > 2) {
    is_log_memory = true;
    memory_consumed = 0; // initialize
}

async function tryURL(url, wants_cookies = "", proxy = "") {
    // JSON for the response
    let payload = {
        body: "",
        status_code: -1,
        status_text: "",
        requested_url: url,
        resolved_url: "",
        error: "",
    };

    let browser;

    // Cookies wanted?
    if (wants_cookies === "true") {
        payload.cookies = "";
    }

    try {
        browser = await puppeteer.connect({
            browserWSEndpoint: "ws://localhost:3000",
        });
        const page = await browser.newPage();
        
        // handle proxy requests manually
        await page.setRequestInterception(true);

        page.on("request", async request => {
            // The below array seeks to filter out unnecessary requests in order to save on bandwidth.
            // IMPORTANT: Some pages require stylsheets to load in order to detected bot behavior. Make sure to allow stylesheet loading!
            if (!["document", "script", "xhr", "stylesheet"].includes(request.resourceType())) {
                request.abort();
                return;
            }
            // document, stylesheet, image, media, font, script, texttrack, xhr, fetch, eventsource, websocket, manifest, other

            logger.debug(`${url}: executing ${request.method()} request to ${request.url()} ${request.postData() ? ", post data: , " + request.postData() : ""}`);
            
            if (proxy) {
                logger.info(`${url}: proxying request for ${request.url()} to ${proxy}`);

                try {
                    await pageProxy(request, proxy);
                } catch (err) {
                    if (request.url() !== url) {
                        logger.warn(`${url}: auxiliary request to ${request.url()} failed: ${err}`);
                    } else {
                        logger.error(`${url}: request failed: ${err}`);
                    }
                    request.abort();
                }
                return;
            }
            request.continue();
            return;
        });

    let response = await page.goto(url,
        {
            timeout: 10 * 60 * 1000, // 10m
            waitUntil: [
                "domcontentloaded",
                "load",
                // "networkidle0", 
                // "networkidle2",
            ],
        });

        // response
        payload.status_code = response?.status();
        payload.status_text = response?.statusText();
        payload.resolved_url = response?.url(); // If there's no response then this is null

        // 200-like status
        if (!response?.ok()) {
            logger.warn(`${url}: unhealthy response => status: ${response?.status()}, response: ${response?.statusText()}`);
        }

        if (wants_cookies) {
            const cookies = await page.cookies(url);
            logger.info(`cookies requested: ${cookies}`);
            payload.cookies = cookies;
        }

        let body = await response?.buffer();
        // TODO: remove, TESTING
        if (is_log_memory) {
            memory_consumed += body?.length;
        }

        payload.body = body.toString();
    } catch (e) {
        payload.status_code = -1;
        payload.error = e.toString();
    } finally {
        if (!payload.error) {
            logger.info(`${url}: successful page visit: ${payload.status_code} - ${payload.status_text}`);
        } else {
            logger.info(`${url}: unsuccessful page visit: ${payload.status_code} - ${payload.status_text}: ${JSON.stringify(payload.error)}`);
        }
        // TODO: remove, TESTING
        if (is_log_memory) {
            logger.info(`${url}: processed ${(memory_consumed >> 20)} MiB (${memory_consumed} bytes) so far`);
        }
        try {
            if (!browser) {
                throw `browser failed to instantiate for ${url}`;
            }
            browser.close();
            logger.info(`${url}: successfully closed page, finished`);
        } catch (e) {
            logger.error(`${url}: failed page close: ${e}`);
        }
    }
    return payload
}

app.get("/health", (_, res) => {
    res.status(200);
    res.end();
});

app.get("/fetch", async (req, res) => {
    logger.info(`${req.query.url}: page visit request received`);
    const url = req.query.url;
    const no_proto = url.slice(0, 4) !== "http";
    const use_cookies = req.query.cookies;
    const proxy = req.query.proxy;
    logger.debug(`fetching with: ${req.query.url}, ${req.query.cookies}, ${req.query.proxy}`)
    res.set("content-type", "application/json");
    if (no_proto) {
        logger.warn(`${url}: no protocol provided`);
        const protos = ["http:", "https:"];
        for (let i in protos) {
            const proto = protos[i];
            const u = `${proto}//${url}`;
            logger.debug(`${url}: trying ${u}`);
            try {
                const payload = await tryURL(u, use_cookies, proxy);
                res.json(payload);
                return;
            } catch (e) {
                logger.error(`${url}: failed ${u.toString()}: ${e}`);
            }
        }
    }
    logger.info(`${url}: starting page visit..`);
    try {
        const payload = await tryURL(url, use_cookies, proxy);
        res.json(payload);
        return;
    } catch (e) {
        logger.error(`${url}: failed: ${e}`);
    }
});

const srv = app.listen(8000, async () => {
    // TODO: remove, TESTING
    if (is_log_memory) {
        logger.info("init: logging memory");
    } else {
        logger.info("init: not logging memory");
    }
    
    logger.info(`init: listening on port 8000 (PID: ${process.pid})`);
});

process.on('SIGINT', function() {
    logger.info('SIGINT received... Stopping HTTP server');
    srv.close(() => {
        console.log('HTTP server stopped.');
    });
});

process.on('SIGTERM', function() {
    logger.info('SIGTERM received... Stopping HTTP server');
    srv.close(() => {
        console.log('HTTP server stopped.');
    });
});