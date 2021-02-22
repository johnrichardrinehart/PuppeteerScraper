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
// Keep track of number of requests for each page
var Mutex = require("async-mutex").Mutex;
const mutex = new Mutex();
// Intercept and manually execute all (non-proxied) requests
const got = require("got");
// Handle a special case related to https://github.com/puppeteer/puppeteer/issues/6913
const IANACodes = require("./lib/iana.json");
// Logging
const winston = require('winston');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        //
        // - Write all logs with level `error` and below to `error.log`
        // - Write all logs with level `info` and below to `combined.log`
        //
        new winston.transports.File({ filename: 'error.log', level: 'error' }),
        new winston.transports.File({ filename: 'combined.log' }),
    ],
});

if (process.env.NODE_ENV !== 'production') {
    logger.add(new winston.transports.Console({
        format: winston.format.simple(),
    }));
}


// Made non-null by init()
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
            // https://stackoverflow.com/a/58589026/1477586
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process', // <- this one doesn't works in Windows
            '--disable-gpu',
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
    logger.info(`${inbound_request.query.url}: page visit request received`);
    // initialize "globals"
    let page;
    // JSON for the response
    let payload = {
        body: "",
        status_code: -1,
        status_text: "",
        requested_url: inbound_request.query.url,
        resolved_url: "",
        error:  "",
    };
    // Cookies wanted?
    if (inbound_request.query.cookies === "true") {
        payload.cookies = "";
    }
    
    let num;
    
    try {
        page = await browser.newPage();
        // handle all requests manually
        await page.setRequestInterception(true);
        
        page.on("request", async request => {
            if (!["document", "script", "xhr", "fetch"].includes(request.resourceType())) {
                request.abort();
                return;
            }
            
            await mutex.runExclusive(async () => {
                num += 1;
            });
            
            if (inbound_request.query.proxy) {
                
                logger.info(`${inbound_request.query.url}: proxying request for ${request.url()} to ${inbound_request.query.proxy}`);
                
                try {
                    await pageProxy(request, inbound_request.query.proxy);
                } catch (err) {
                    if (request.url() !== inbound_request.query.url) {
                        logger.warn(`${inbound_request.query.url}: auxiliary request to ${request.url()} failed: ${err}`);
                    } else {
                        logger.error(`${inbound_request.query.url}: request failed: ${err}`); 
                    }
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
                    logger.warn(`${inbound_request.query.url}: auxiliary request to ${request.url()} failed: ${err}`);
                } else {
                    logger.error(`${inbound_request.query.url}: request failed: ${err}`); 
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
                logger.info(`${inbound_request.query.url}: replacing incompatible code ${code} for ${request.url()} with ${n_code}`)
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
                logger.warn(`${inbound_request.query.url}: unhealthy response => status: ${response?.status()}, response: ${response?.statusText()}`);
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
                logger.info(`${inbound_request.query.url}: successful page visit: ${payload.status_code} - ${payload.status_text}`);
            } else {
                logger.info(`${inbound_request.query.url}: unsuccessful page visit: ${payload.status_code} - ${payload.status_text}: ${payload.error}`);
            }
            
            // TODO: remove, TESTING
            if (is_log_memory) {
                logger.info(`${indbound_request_query.url}: processed ${(memory_consumed >> 20)} MiB (${memory_consumed} bytes) so far`);
            }
            try {
                await page.close()
            } catch (e) {
                logger.error(`${inbound_request.query.url}: failed page close: ${e}`);
            }
        }
    });
    
    app.listen(8000, async () => {
        await init(); // initialize the browser
        // TODO: remove, TESTING
        if (is_log_memory) {
            logger.info("init: logging memory");
        } else {
            logger.info("init: not logging memory");
        }
        
        logger.info(`init: listening on port 8000 (PID: ${process.pid})`);
        
        // Here we send the ready signal to PM2
        if (process.send) {
            process.send("ready");
        }
    });