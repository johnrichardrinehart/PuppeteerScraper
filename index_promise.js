const express = require('express');
const app = express();

const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')

puppeteer.use(StealthPlugin())

let browser

async function init() {
	browser = await puppeteer.launch();
}

app.get('/content', async (req, res) => {
	await init()

	console.log(`received a request for ${req.query.url}`);

	// initialize "globals"
	let data
	let page

	await browser.newPage()
		.then(pg => {
			page = pg; // set "global" so we can close in .finally
			return page
		})
		.then(page => page.goto(req.query.url,{
			timeout: 10000 // 10s
		})
			.then(res => {
				if (!res.ok()) {
					throw `errored response: ${req.query.url} returned ${res.status()}, ${res.statusCode()}`
				}
				return res.text()
			})
			.then(txt => {
				res.status(200);
				res.set('content-type', 'text/html');
				data = txt;
			})
			.catch(e => {
				console.log(`big uh-oh: ${e}`);
				res.status(500);
			})
			.finally(() => {
				res.end(data); // null if .catch
				page.close().catch(e => {console.log(`failed to close page for ${req.query.url}: ${e}`)});
			})
})

	console.log("listening on port 8000")
	app.listen(8000);
