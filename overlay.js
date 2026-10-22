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
  // Departures board settings
  stationA: "TPE",
  stationB: "LLH",
  locationRatio: 0.25,
  boardIntervalMs: 60000,
  boardErrorTimeoutMs: 180000,
  // Timeout settings
  ghostTrainTimeoutMs: 5 * 60 * 1000,
  passedGracePeriodMs: 90 * 1000,
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
    this.client = null;
    this.options = options;
    this.data = data;
    this.connected = false;
    this.changed = false;
    this.$ = null;

    // Board error tracking
    this.lastSuccessfulFetch = Date.now();
    this.fetchErrorCount = 0;

    this.loadSvg();
    setInterval(this.saveSvg.bind(this), 5000);

    // Initial fetch and start interval for departures board
    this.fetchDepartures();
    setInterval(
      this.fetchDepartures.bind(this),
      this.options.boardIntervalMs || 30000,
    );
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

  // --- Departures Board Helpers ---

  setBoardText(id, text, fill = "#ffffff") {
    if (debug) console.log(id, "set board text", text, fill);

    const el = this.$(`#${id}`);
    const targets = el.children().length > 0 ? el.children() : el;
    targets.text(text);

    // Apply fill color (defaulting to white) and clear any leftover stroke
    el.css("fill", fill);
    el.children().css("fill", fill);
    el.css("stroke", "");
    el.children().css("stroke", "");

    this.changed = true;
  }

  clearBoardText(id) {
    if (debug) console.log(id, "clear board text");

    const el = this.$(`#${id}`);
    if (el.children().length > 0) {
      el.children().text("");
      el.children().css("fill", "#ffffff");
      el.children().css("stroke", "");
    } else {
      el.text("");
    }
    el.css("fill", "#ffffff");
    el.css("stroke", "");

    this.changed = true;
  }

  clearDeparturesBoard() {
    if (!this.data.departuresBoard) return;

    for (const row of this.data.departuresBoard) {
      if (row.fields) {
        for (const field of row.fields) {
          if (field.svgText) {
            this.clearBoardText(field.svgText);
          }
        }
      }
    }
  }

  formatTime(time) {
    if (!time) return "";
    const rawMs = typeof time === "number" ? time : new Date(time).getTime();
    if (isNaN(rawMs)) return "";

    // Round up (ceil) to the nearest full minute
    const ceilMs = Math.ceil(rawMs / 60000) * 60000;
    const date = new Date(ceilMs);

    const formatted = date.toLocaleTimeString("fi-FI", {
      timeZone: "Europe/Helsinki",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return formatted.replace(":", ".");
  }

  showBoardError(title = "EI TIETOA", subtitle = "NO DATA") {
    this.clearDeparturesBoard();

    const boardRows = this.data.departuresBoard || [];
    if (boardRows.length === 0) return;

    // Row 1: Primary error message
    const row1 = boardRows[0];
    if (row1 && row1.fields) {
      for (const field of row1.fields) {
        if (!field.svgText) continue;
        if (field.type === "train") this.setBoardText(field.svgText, "ERR");
        else if (field.type === "time")
          this.setBoardText(field.svgText, "--.--");
        else if (field.type === "destination")
          this.setBoardText(field.svgText, title);
        else if (field.type === "direction")
          this.setBoardText(field.svgText, "!");
      }
    }

    // Row 2: Secondary / Subtitle message (if a second row is configured)
    if (boardRows.length > 1 && subtitle) {
      const row2 = boardRows[1];
      if (row2 && row2.fields) {
        for (const field of row2.fields) {
          if (!field.svgText) continue;
          if (field.type === "destination")
            this.setBoardText(field.svgText, subtitle);
          else if (field.type === "time") this.setBoardText(field.svgText, "");
          else if (field.type === "train") this.setBoardText(field.svgText, "");
          else if (field.type === "direction")
            this.setBoardText(field.svgText, "");
        }
      }
    }
  }

  handleFetchError(err) {
    this.fetchErrorCount++;
    console.error(
      `[API Error] Failed fetching train data (${this.fetchErrorCount} in a row):`,
      err.message || err,
    );

    const errorThreshold = this.options.boardErrorTimeoutMs || 90000;
    const offlineDuration = Date.now() - this.lastSuccessfulFetch;

    // Show error message on the board if offline past grace period or >= 3 failures
    if (offlineDuration >= errorThreshold || this.fetchErrorCount >= 3) {
      this.showBoardError("EI TIETOA", "NO DATA");
    }
  }

  async fetchDepartures() {
    const stationA = this.options.stationA || "TPE";
    const stationB = this.options.stationB || "LLH";

    const query = `{
      trainsByStationAndQuantity(
        station: "${stationA}"
        includeNonStopping: true
        arrivedTrains: 0
        arrivingTrains: 30
        departedTrains: 0
        departingTrains: 30
        where: { timeTableRows: { contains: { station: { shortCode: { equals: "${stationB}" } } } } }
      ) {
        trainNumber
        departureDate
        trainType { name trainCategory { name } }
        commuterLineid
        operator { uicCode }
        cancelled
        timetableType
        timeTableRows(orderBy: { scheduledTime: ASCENDING }) {
          station { shortCode name }
          type
          commercialStop
          commercialTrack
          scheduledTime
          liveEstimateTime
          actualTime
          differenceInMinutes
          cancelled
        }
      }
    }`;

    try {
      // 10-second request timeout to prevent hanging connections
      const signal = AbortSignal.timeout
        ? AbortSignal.timeout(10000)
        : undefined;

      const response = await fetch(
        "https://rata.digitraffic.fi/api/v2/graphql/graphql",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Encoding": "gzip",
            "Digitraffic-User": "Raiteilla/ServiceViewer 1.0",
          },
          body: JSON.stringify({ query }),
          signal,
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }

      const json = await response.json();

      if (json.errors && json.errors.length > 0) {
        throw new Error(`GraphQL: ${json.errors[0].message}`);
      }

      // Success: reset error counters
      this.lastSuccessfulFetch = Date.now();
      this.fetchErrorCount = 0;

      this.updateDeparturesBoard(json);
    } catch (err) {
      this.handleFetchError(err);
    }
  }

  updateDeparturesBoard(apiData) {
    this.clearDeparturesBoard();

    const trains = apiData?.data?.trainsByStationAndQuantity;
    if (!trains || !Array.isArray(trains)) {
      return;
    }

    const stationA = this.options.stationA || "TPE";
    const stationB = this.options.stationB || "LLH";
    const ratio = this.options.locationRatio ?? 0.5;
    const now = Date.now();
    const maxPastMs = 15 * 60 * 1000;

    const passingServices = [];
    const seenTrainKeys = new Set();

    for (const train of trains) {
      if (train.cancelled) continue;

      const trainKey = `${train.trainNumber}_${train.departureDate}`;
      if (seenTrainKeys.has(trainKey)) continue;
      seenTrainKeys.add(trainKey);

      const rows = train.timeTableRows || [];
      const idxA = rows.findIndex((r) => r.station.shortCode === stationA);
      const idxB = rows.findIndex((r) => r.station.shortCode === stationB);

      if (idxA === -1 || idxB === -1) continue;

      let fromRow, toRow, fraction, direction;

      if (idxA < idxB) {
        // Direction: stationA -> stationB (→)
        direction = "→";
        fraction = ratio;

        fromRow =
          rows
            .slice(idxA)
            .find(
              (r) => r.station.shortCode === stationA && r.type === "DEPARTURE",
            ) || rows[idxA];
        toRow =
          rows
            .slice(idxA)
            .find(
              (r) => r.station.shortCode === stationB && r.type === "ARRIVAL",
            ) ||
          rows.slice(idxA).find((r) => r.station.shortCode === stationB) ||
          rows[idxB];
      } else {
        // Direction: stationB -> stationA (←)
        direction = "←";
        fraction = 1.0 - ratio;

        fromRow =
          rows
            .slice(idxB)
            .find(
              (r) => r.station.shortCode === stationB && r.type === "DEPARTURE",
            ) || rows[idxB];
        toRow =
          rows
            .slice(idxB)
            .find(
              (r) => r.station.shortCode === stationA && r.type === "ARRIVAL",
            ) ||
          rows.slice(idxB).find((r) => r.station.shortCode === stationA) ||
          rows[idxA];
      }

      if (!fromRow || !toRow) continue;
      if (fromRow.cancelled || toRow.cancelled) continue;

      // 1. Actual arrival/passing at destination station clears the train immediately
      if (toRow.actualTime) continue;

      const hasDeparted = fromRow.type === "DEPARTURE" && !!fromRow.actualTime;
      const schedFrom = new Date(fromRow.scheduledTime).getTime();
      const schedTo = new Date(toRow.scheduledTime).getTime();
      const schedDuration = Math.max(schedTo - schedFrom, 60000);
      const schedPassage = schedFrom + fraction * schedDuration;

      // If a train has a commercial stop and hasn't departed, hold scheduled departure
      let effectiveLiveFrom = fromRow.liveEstimateTime || fromRow.scheduledTime;
      const isCommercialStop =
        fromRow.commercialStop === true || !!fromRow.commercialTrack;

      if (!hasDeparted && isCommercialStop && fromRow.liveEstimateTime) {
        const estMs = new Date(fromRow.liveEstimateTime).getTime();
        const schedMs = new Date(fromRow.scheduledTime).getTime();
        if (estMs < schedMs) {
          effectiveLiveFrom = fromRow.scheduledTime;
        }
      }

      let liveFrom = new Date(
        (hasDeparted ? fromRow.actualTime : null) || effectiveLiveFrom,
      ).getTime();

      let liveTo = new Date(
        toRow.actualTime || toRow.liveEstimateTime || toRow.scheduledTime,
      ).getTime();

      if (liveTo < liveFrom) {
        liveTo = liveFrom + schedDuration;
      }
      const liveDuration = Math.max(liveTo - liveFrom, 60000);
      const livePassage = liveFrom + fraction * liveDuration;

      // Ghost train & stale passage filtering
      const ghostTimeoutMs = this.options.ghostTrainTimeoutMs ?? 15 * 60 * 1000;
      const passedGraceMs = this.options.passedGracePeriodMs ?? 90 * 1000;

      const isSchedExpired = schedPassage < now - ghostTimeoutMs;
      const isLiveExpired = livePassage < now - ghostTimeoutMs;
      if (isSchedExpired && isLiveExpired) {
        continue;
      }

      if (!hasDeparted && schedFrom < now - ghostTimeoutMs && liveFrom < now - ghostTimeoutMs) {
        continue;
      }

      if (livePassage < now - passedGraceMs) {
        continue;
      }
      
      // Train details
      const diffMs = livePassage - schedPassage;

      let trainName = "";
      if (train.commuterLineid) {
        trainName = `${train.trainNumber}${train.commuterLineid}`.trim();
      } else {
        const type = train.trainType?.name || "";
        trainName = `${type}${train.trainNumber}`.trim();
      }

      // Find downstream destination: last non-cancelled stop in sequence
      const downstreamStartIdx = idxA < idxB ? idxB : idxA;
      const downstreamRows = rows.slice(downstreamStartIdx);

      let destRow = null;
      for (let i = downstreamRows.length - 1; i >= 0; i--) {
        if (!downstreamRows[i].cancelled) {
          destRow = downstreamRows[i];
          break;
        }
      }

      if (!destRow) {
        destRow = rows[rows.length - 1];
      }

      let destination =
        destRow?.station?.name || destRow?.station?.shortCode || "";
      destination = destination.replace(/\s+asema$/i, "");

      passingServices.push({
        trainName,
        destination,
        direction,
        track:
          (idxA < idxB ? fromRow.commercialTrack : toRow.commercialTrack) || "",
        livePassage,
        diffMs,
      });
    }

    passingServices.sort((a, b) => a.livePassage - b.livePassage);

    const boardRows = this.data.departuresBoard || [];
    boardRows.forEach((rowConfig, idx) => {
      const service = passingServices[idx];
      if (!service) return;

      for (const field of rowConfig.fields) {
        if (!field.svgText) continue;

        let value = "";
        let fill = "#ffffff";

        switch (field.type) {
          case "direction":
            value = service.direction;
            break;
          case "time":
            value = this.formatTime(service.livePassage);

            if (service.diffMs >= 6 * 60 * 1000) {
              fill = "#ff3131"; // 6+ mins late
            } else if (service.diffMs <= -6 * 60 * 1000) {
              fill = "#00bfff"; // 6+ mins early
            }
            break;
          case "train":
            value = service.trainName;
            break;
          case "destination":
            value = service.destination;
            break;
          case "track":
            value = service.track;
            break;
        }

        this.setBoardText(field.svgText, value, fill);
      }
    });
  }

  // --- Track / Signal Clearing & Drawing ---

  clearAll() {
    this.clearDeparturesBoard();

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

    // clear any other instances of this text (used for train IDs on tracks)
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
        out.push(this.data.signals[r.sectionId]);
      } else {
        const signals = this.findSignalsByTrack(trackSection);
        for (const sig of signals) {
          if (sig.previousTrackSection === previousTrackSection) {
            out.push(sig);
          }
        }
      }

      previousTrackSection = trackSection;
    }

    return out;
  }

  onRouteSetMessage(msg) {
    if (msg.clientSystem !== "TAKO") {
      return;
    }

    if (
      msg.routesections.filter((s) =>
        this.options.stations.includes(s.stationCode),
      ).length === 0
    ) {
      return;
    }

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

    this.setRoute(msg.routesections, msg.routeType);
  }

  onTrainTrackingMessage(msg) {
    if (debug && showMessages) {
      console.log(
        msg.trainNumber.padStart(8, " "),
        msg.type.padStart(8, " "),
        msg.trackSection,
      );
    }

    if (this.data.trackSections.hasOwnProperty(msg.trackSection)) {
      const track = this.data.trackSections[msg.trackSection];

      if (msg.type === "OCCUPY") {
        if (track.svgText !== undefined) {
          this.setText(track.svgText, msg.trainNumber);
        }
        if (track.type === "turnout") {
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
