const express = require('express');
const app = express();

const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

puppeteer.use(StealthPlugin())

let browser

async function init() {
	browser = await puppeteer.launch();
}


console.log(`${process.argv.length} arguments passed`);

// TODO: remove, TESTING
let memory_consumed
let is_log_memory
// keep track of cumulative memory allocated
if (process.argv.length > 2 ) {
	is_log_memory = true;
	memory_consumed = 0; // initialize
}

app.get('/content', async (req, res) => {

	console.log(`received a request for ${req.query.url}`);

	// initialize "globals"
	let data
	let page

	try {
		page = await browser.newPage();
		out = await page.goto(req.query.url, {
			timeout: 10000, // 10s
		});

		// 200-like status
		if (!out.ok()) {
			throw `errored response: ${req.query.url} returned ${out.status()}, ${out.statusText()}`
		}

		const buf = await out.buffer()

		// TODO: remove, TESTING
		if (is_log_memory) {
			memory_consumed += buf.length
		}

		res.status(200);
		res.set('content-type', 'text/html');

	} catch (e) {
		console.log(`we encountered an error in fetching the page ${req.query.url}: ${e}`);
		res.status(500);
	} finally {
		res.end(data);

		// TODO: remove, TESTING
		if (is_log_memory) {
			console.log(`processed ${(memory_consumed >> 20)} MiB (${memory_consumed} bytes) so far`);
		}

		await page.close().catch(e => {console.log(`failed to close page for ${req.query.url}: ${e}`)});
	}
})

app.listen(8000, async () => {
	await init() // initialize the browser

	// TODO: remove, TESTING
	if (is_log_memory) {
		console.log("logging memory");
	} else {
		console.log("not logging memory");
	}

	console.log(`listening on port 8000 (${process.pid})`)

	// Here we send the ready signal to PM2
	if (process.send) {
		process.send('ready');
	}
});
