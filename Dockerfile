FROM browserless/chrome:latest AS browserless

# Put this repo into the image
ENV SCRAPER_APP_DIR=/usr/src/scraper
WORKDIR $SCRAPER_APP_DIR
COPY . $SCRAPER_APP_DIR

# Install dependencies
USER root
RUN npm install -g yarn
RUN yarn set version berry
RUN yarn install

USER blessuser

CMD ["./start.sh"]
