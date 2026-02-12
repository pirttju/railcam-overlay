const cheerio = require("cheerio");
const fs = require("fs");
const mqtt = require("mqtt");
const path = require("path");
const shell = require("shelljs");

const debug = false;
const showMessages = false;

// /run/user/1000/restreamer/
const options = {
  loadPath: "overlay.svg",
  savePath: "mask.svg",
  url: "mqtt://rata-mqtt.digitraffic.fi",
  topics: ["train-tracking/+/+/+/TPE/#", "routesets/#"],
  stations: ["TPE", "TRE"],
};

const data = require("./overlay.json");

function pairwise(arr, func) {
  for (let i = 0; i < arr.length; i++) {
    if (i === arr.length - 1) {
      func(arr[i], undefined);
    } else {
      func(arr[i], arr[i + 1]);
    }
  }
}

class TrainOverlay {
  constructor(options, data) {
    this.client;
    this.options = options;
    this.data = data;
    this.connected = false;
    this.changed = false;
    this.$;
    this.loadSvg();
    setInterval(this.saveSvg.bind(this), 2000);
  }

  loadSvg() {
    const svgContent = fs.readFileSync(this.options.loadPath, {
      encoding: "utf-8",
    });
    this.$ = cheerio.load(svgContent, { xml: true });
  }

  saveSvg() {
    if (!this.changed) {
      return;
    }

    fs.writeFile(this.options.savePath, this.$.xml(), (err) => {
      if (err) {
        console.log("Error saving:", err);
      }
      if (debug) console.log("The file was saved!");

      this.changed = false;

      // convert
      shell.exec(path.join(__dirname, "./convert.sh"));
    });
  }

  clearAll() {
    // look up all tracks
    for (const [key, value] of Object.entries(this.data.trackSections)) {
      if (value.svgText !== undefined) {
        this.clearText(value.svgText);
      }
      if (value.svgPath !== undefined) {
        this.setTrackReleased(value.svgPath);
      }
      if (value.type === "turnout") {
        for (const part of value.trackParts) {
          if (part.svgPath !== undefined) {
            this.setTrackReleased(part.svgPath);
          }
        }
      }
    }
    // look up all signals
    for (const [key, value] of Object.entries(this.data.signals)) {
      if (value.svgPath !== undefined) {
        this.setSignalStop(value.svgPath);
      }
    }
  }

  setText(id, text) {
    if (debug) console.log(id, "set text", text);

    // clear any other instances of this text
    const contains = this.$("text");
    for (const c of contains) {
      if (this.$(c).children().text() === text) {
        this.$(c).children().text("");
      }
    }

    // set this
    this.$(`#${id}`).children().text(text);

    this.changed = true;
  }

  clearText(id) {
    if (debug) console.log(id, "clear text");

    this.$(`#${id}`).children().text("");

    this.changed = true;
  }

  setTrackOccupied(id) {
    if (debug) console.log(id, "stroke red");

    this.$(`#${id}`).css("stroke", "#ff0000");
    this.popToFront(id);

    this.changed = true;
  }

  setTrackReleased(id) {
    if (debug) console.log(id, "stroke white");

    this.$(`#${id}`).css("stroke", "#ffffff");

    this.changed = true;
  }

  setTrackRoute(id, type) {
    if (type === "C") {
      this.setTrackReleased(id);
      return;
    }
    const color = type === "T" ? "#00ff00" : "#ffff00";
    if (debug) console.log(id, "stroke", color);

    this.$(`#${id}`).css("stroke", color);
    this.popToFront(id);

    this.changed = true;
  }

  setSignalStop(id) {
    if (debug) console.log(id, "fill red");

    this.$(`#${id}`).css("fill", "#ff0000");

    this.changed = true;
  }

  setSignalClear(id, type) {
    if (type === "main") {
      if (debug) console.log(id, "fill green");
      this.$(`#${id}`).css("fill", "#00ff00");
    } else {
      if (debug) console.log(id, "fill yellow");
      this.$(`#${id}`).css("fill", "#ffff00");
    }

    this.changed = true;
  }

  popToFront(id) {
    this.$(`#${id}`)
      .parent()
      .append(this.$(`#${id}`));
  }

  setRoute(routeSections, routeType) {
    let previousTrackSection = "";

    pairwise(routeSections, (section, nextSection) => {
      const trackSection = `${section.stationCode}_${section.sectionId}`;
      let nextTrackSection = "";

      if (nextSection !== undefined) {
        nextTrackSection = `${nextSection.stationCode}_${nextSection.sectionId}`;
      }

      if (this.data.trackSections.hasOwnProperty(trackSection)) {
        const track = this.data.trackSections[trackSection];

        if (track.svgPath !== undefined) {
          this.setTrackRoute(track.svgPath, routeType);
        } else if (track.type === "turnout") {
          // find track part
          for (const part of track.trackParts) {
            if (
              (part.previousTrackSection.includes(previousTrackSection) &&
                part.nextTrackSection.includes(nextTrackSection)) ||
              (part.nextTrackSection.includes(previousTrackSection) &&
                part.previousTrackSection.includes(nextTrackSection))
            ) {
              if (part.svgPath !== undefined) {
                this.setTrackRoute(part.svgPath, routeType);
              }
            } else {
              if (part.svgPath !== undefined) {
                this.setTrackReleased(part.svgPath);
              }
            }
          }
        }
      }

      previousTrackSection = trackSection;
    });
  }

  findSignalById(id) {
    if (this.data.signals.hasOwnProperty(id)) {
      return this.data.signals[id];
    }

    return undefined;
  }

  findSignalsByTrack(trackSection) {
    const out = [];
    for (const [key, value] of Object.entries(this.data.signals)) {
      if (value.nextTrackSection === trackSection) {
        out.push(value);
      }
    }

    return out;
  }

  findSignalsByRoute(routeSections) {
    const out = [];

    let previousTrackSection = "";
    for (const r of routeSections) {
      const trackSection = `${r.stationCode}_${r.sectionId}`;
      if (this.data.signals.hasOwnProperty(r.sectionId)) {
        // elements match
        out.push(this.data.signals[r.sectionId]);
      } else {
        // lookup by track section
        const signals = this.findSignalsByTrack(trackSection);
        for (const sig of signals) {
          if (sig.previousTrackSection === previousTrackSection) {
            // track sections match
            out.push(sig);
          }
        }
      }

      // set as previous
      previousTrackSection = trackSection;
    }

    return out;
  }

  // handles messages from routesets topic
  onRouteSetMessage(msg) {
    // filter out messages not from TAKO
    if (msg.clientSystem !== "TAKO") {
      return;
    }

    // filter out messages not from stations of interest
    if (
      msg.routesections.filter((s) =>
        this.options.stations.includes(s.stationCode)
      ).length === 0
    ) {
      return;
    }

    // filter out old "ghost messages"
    const d1 = new Date(msg.messageTime);
    const d2 = Date.now();
    const diff = d2 - d1;

    if (diff > 120e3) {
      console.log("rejected old routeset:");
      console.log(JSON.stringify(msg));
      return;
    }

    if (debug && showMessages) {
      let formattedMsg = msg.trainNumber.padStart(8, " ");
      formattedMsg += " ";
      formattedMsg += msg.routeType;

      for (const r of msg.routesections) {
        formattedMsg += ` ${r.stationCode}_${r.sectionId}`;
      }
      console.log(formattedMsg);
    }

    // find signals
    const signals = this.findSignalsByRoute(msg.routesections);
    for (const sig of signals) {
      if (sig.svgPath !== undefined) {
        this.setSignalClear(sig.svgPath, sig.type);
        if (sig.connectedSignal !== undefined) {
          const subSig = this.findSignalById(sig.connectedSignal);
          if (subSig.svgPath !== undefined) {
            this.setSignalClear(subSig.svgPath, subSig.type);
          }
        }
      }
    }

    // set route
    this.setRoute(msg.routesections, msg.routeType);
  }

  // handles messages from train tracking topic
  onTrainTrackingMessage(msg) {
    if (debug && showMessages) {
      console.log(
        msg.trainNumber.padStart(8, " "),
        msg.type.padStart(8, " "),
        msg.trackSection
      );
    }

    // update track occupation
    if (this.data.trackSections.hasOwnProperty(msg.trackSection)) {
      const track = this.data.trackSections[msg.trackSection];

      if (msg.type === "OCCUPY") {
        if (track.svgText !== undefined) {
          this.setText(track.svgText, msg.trainNumber);
        }
        if (track.type === "turnout") {
          // find track part
          for (const part of track.trackParts) {
            if (
              (part.previousTrackSection.includes(msg.previousTrackSection) &&
                part.nextTrackSection.includes(msg.nextTrackSection)) ||
              (part.nextTrackSection.includes(msg.previousTrackSection) &&
                part.previousTrackSection.includes(msg.nextTrackSection))
            ) {
              if (part.svgPath !== undefined) {
                this.setTrackOccupied(part.svgPath);
              }
            }
          }
        } else {
          if (track.svgPath !== undefined) {
            this.setTrackOccupied(track.svgPath);
          }
        }
      } else if (msg.type === "RELEASE") {
        if (track.svgText !== undefined) {
          this.clearText(track.svgText);
        }
        if (track.svgPath !== undefined) {
          this.setTrackReleased(track.svgPath);
        } else if (track.type === "turnout") {
          for (const part of track.trackParts) {
            if (part.svgPath !== undefined) {
              this.setTrackReleased(part.svgPath);
            }
          }
        }
      }
    }

    // update associated signals
    if (msg.type === "OCCUPY") {
      const signals = this.findSignalsByTrack(msg.trackSection);
      for (const sig of signals) {
        this.setSignalStop(sig.svgPath);

        if (sig.connectedSignal !== undefined) {
          const subSig = this.findSignalById(sig.connectedSignal);
          if (subSig.svgPath !== undefined) {
            this.setSignalStop(subSig.svgPath);
          }
        }
      }
    }
  }

  onConnect() {
    console.log("MQTT connected");
    this.connected = true;
    this.client.subscribe(this.options.topics);
  }

  connect() {
    if (this.connected) {
      return;
    }

    this.clearAll();

    console.log(`Connecting to ${this.options.url}...`);

    this.client = mqtt.connect(this.options.url);
    this.client.on("connect", () => this.onConnect());
    this.client.on("close", () => console.log("MQTT disconnected"));
    this.client.on("reconnect", () => console.log("MQTT reconnect started"));
    this.client.on("error", (error) => console.log(`MQTT error: ${error}`));
    this.client.on("message", (topic, payload) => {
      let parsed;
      try {
        parsed = JSON.parse(payload.toString());
      } catch (error) {
        console.log(`JSON parse failed on ${topic}: ${error}`);
        return;
      }
      if (topic.startsWith("train-tracking")) {
        this.onTrainTrackingMessage(parsed);
      } else if (topic.startsWith("routesets")) {
        this.onRouteSetMessage(parsed);
      }
    });
  }
}

const overlay = new TrainOverlay(options, data);
overlay.connect();
