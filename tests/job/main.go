package main

import (
	"bufio"
	"database/sql"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

var netClient = &http.Client{
	Timeout: 5 * time.Minute,
}

type result struct {
	Body         string `json:"body"`
	Error        string `json:"error"`
	Cookies      string `json:"cookies,omitempty"`
	StatusCode   int    `json:"status_code"`
	Status       string `json:"status_text"`
	RequestedURL string `json:"requested_url"`
	ResolvedURL  string `json:"resolved_url"`
	duration     int64
}

var results = make(map[string]result)

func main() {
	os.Remove("./foo.db")

	db, err := sql.Open("sqlite3", "./foo.db")
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()

	sqlStmt := `
	create table results (requested_url text not null primary key, html text, error string, cookies text, status_code int, status_text text, resolved_url text, duration_ms int not null);
	delete from results;
	`
	_, err = db.Exec(sqlStmt)
	if err != nil {
		log.Fatalf("%q: %s\n", err, sqlStmt)
	}

	qryInsertReslt, err := db.Prepare("insert into results(requested_url, html, error, cookies, status_code, status_text, resolved_url, duration_ms) values (?,?,?,?,?,?,?,?)") // url, HTML, error, cookies, statsuCode, status
	if err != nil {
		log.Fatal(err)
	}
	defer qryInsertReslt.Close()

	scraper := flag.String("s", "http://localhost:8000", "address of the scraper")
	fn := flag.String("i", "url.txt", "input file (urls, whitespace-delimited")
	n := flag.Int("n", 10, "number of URLs to scrape - 0 scrapes all")
	N := flag.Int("N", 5, "number of workers")
	cookies := flag.Bool("c", false, "get cookies?")
	proxy := flag.String("p", "", "proxy address")
	// d := flag.Duration("d", 5*time.Second, "period delay between concurrent URL requests")
	flag.Parse()

	f, err := os.Open(*fn)
	if err != nil {
		log.Fatalf("failed to open URL list: %s", *fn)
	}
	s := bufio.NewScanner(f)

	chURLs := make(chan string)
	chResults := make(chan result)
	chDone := make(chan bool)

	var num int

	// DB goroutine
	go func() {
		for r := range chResults {
			num++
			log.Printf("completed result %d (%s): Response Status: %s, Error: %s", num, r.RequestedURL, r.Status, r.Error)
			if _, err := qryInsertReslt.Exec(r.RequestedURL, r.Body, r.Error, r.Cookies, r.StatusCode, r.Status, r.ResolvedURL, r.duration); err != nil {
				log.Printf("failed to insert result for %s: %s", r.RequestedURL, err)
			}
		}
		close(chDone)
	}()

	var wg sync.WaitGroup

	for i := 0; i < *N; i++ {
		w := worker{
			scraper: *scraper,
			proxy:   *proxy,
			cookies: *cookies,
		}
		wg.Add(1)
		go w.work(chURLs, chResults, &wg)
	}

	log.Printf("workers spun up")

	for cnt, more := 0, s.Scan(); cnt < *n && more; cnt, more = cnt+1, s.Scan() {
		url := s.Text()
		log.Printf("started result %d (%s)", cnt, url)
		chURLs <- url
	}
	log.Printf("all done sending URLs to workers")
	close(chURLs)
	wg.Wait()
	close(chResults) // signal the DB goroutine to exit
	<-chDone         // closed by the DB goroutine

	log.Printf("done")
}

type worker struct {
	scraper string
	proxy   string
	cookies bool
}

func (w *worker) work(urls <-chan string, results chan<- result, wg *sync.WaitGroup) {
	defer wg.Done()
	for url := range urls {
		u, err := makeURL(w.scraper, w.proxy, url, w.cookies)
		if err != nil {
			log.Printf("could not make a URL for %s: %s", url, err)
		}
		start := time.Now()
		r, err := getResult(u)
		if err != nil {
			log.Printf("failed to get result for %s: %s", url, err)
			return
		}
		duration := time.Now().Sub(start)
		r.duration = duration.Milliseconds()
		results <- *r
	}

}

func makeURL(scraper string, proxy string, urlToFetch string, isGetCookies bool) (*url.URL, error) {
	p := fmt.Sprintf(`%s/fetch?url=%s`, scraper, urlToFetch)
	if proxy != "" {
		p += fmt.Sprintf("&proxy=%s", proxy)
	}
	if isGetCookies {
		p += fmt.Sprintf("&cookies=true")
	}
	return url.Parse(p)
}

func getResult(u *url.URL) (*result, error) {
	resp, err := netClient.Get(u.String())
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	return responseToResult(resp)
}

func responseToResult(r *http.Response) (*result, error) {
	var res result

	if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
		return nil, err
	}

	return &res, nil
}
