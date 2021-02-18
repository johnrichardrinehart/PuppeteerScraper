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

	let data
	let page

	try {
		page = await browser.newPage();
		res = await page.goto(req.query.url, {
			timeout: 10000, // 10s
		});
		data = await res.text()

		res.status(200);
		res.set('content-type', 'text/html');

	} catch (e) {
		console.log(`we encountered an error in fetching the page ${req.query.url}: ${e}`);
		res.status(500);
	} finally {
		res.end(data);
		await page.close();
	}
})

console.log("listening on port 8000")
app.listen(8000);
