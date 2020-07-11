FROM ubuntu:20.10

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y locales

RUN locale-gen en_US.UTF-8
ENV LANG en_US.UTF-8
ENV LANGUAGE en_US:en
ENV LC_ALL en_US.UTF-8

RUN apt-get update \
 && apt-get install --yes apt-utils \
 && apt-get install --yes ffmpeg melt

RUN apt-get install -y nodejs npm

WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci
COPY . .
ENTRYPOINT [ "node", "--inspect=0.0.0.0:9229", "index.js" ]
