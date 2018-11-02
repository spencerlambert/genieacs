/**
 * Copyright 2013-2018  Zaid Abdulla
 *
 * This file is part of GenieACS.
 *
 * GenieACS is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * GenieACS is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with GenieACS.  If not, see <http://www.gnu.org/licenses/>.
 */
"use strict";

const vm = require("vm");
const crypto = require("crypto");

const db = require("./db");
const cache = require("./cache");
const query = require("./query");
const logger = require("./logger");
const scheduling = require("./scheduling");

const REFRESH = 3000;

let nextRefresh = 1;
let hash = null;
let presets, provisions, virtualParameters, files;

function computeHash() {
  // MD5 hash for presets, provisions, virtual parameters for detecting changes
  const h = crypto.createHash("md5");
  for (const p of presets) {
    h.update(JSON.stringify(p.name));
    h.update(JSON.stringify(p.channel));
    h.update(JSON.stringify(p.schedule));
    h.update(JSON.stringify(p.events));
    h.update(JSON.stringify(p.precondition));
    h.update(JSON.stringify(p.provisions));
  }

  let keys;

  keys = Object.keys(provisions).sort();
  h.update(JSON.stringify(keys));
  for (const k of keys) h.update(provisions[k].md5);

  keys = Object.keys(virtualParameters).sort();
  h.update(JSON.stringify(keys));
  for (const k of keys) h.update(virtualParameters[k].md5);

  hash = h.digest("hex");
}

function flattenObject(src, prefix = "", dst = {}) {
  for (const k of Object.keys(src)) {
    const v = src[k];
    if (typeof v === "object" && !Array.isArray(v))
      flattenObject(v, `${prefix}${k}.`, dst);
    else dst[`${prefix}${k}`] = v;
  }
  return dst;
}

function refresh(callback) {
  if (!nextRefresh) {
    return void setTimeout(() => {
      refresh(callback);
    }, 20);
  }

  nextRefresh = 0;
  const now = Date.now();

  cache.get("presets_hash", (err, dbHash) => {
    if (err) return void callback(err);

    if (hash && dbHash === hash) {
      nextRefresh = now + (REFRESH - (now % REFRESH));
      return void callback();
    }

    cache.lock("presets_hash_lock", 3, (err, unlockOrExtend) => {
      if (err) return void callback(err);

      let counter = 3;

      counter += 2;
      db.getPresets((err, res) => {
        if (err) {
          if (counter & 1) callback(err);
          return void (counter = 0);
        }

        db.getObjects((err, objects) => {
          if (err) {
            if (counter & 1) callback(err);
            return void (counter = 0);
          }

          objects = objects.map(obj => {
            // Flatten object
            obj = flattenObject(obj);

            // If no keys are defined, consider all parameters as keys to keep the
            // same behavior from v1.0
            if (!obj["_keys"] || !obj["_keys"].length)
              obj["_keys"] = Object.keys(obj).filter(k => !k.startsWith("_"));

            return obj;
          });

          res.sort((a, b) => {
            if (a.weight === b.weight) return a._id > b._id;
            else return a.weight - b.weight;
          });

          presets = [];
          for (const preset of res) {
            let schedule = null;
            if (preset.schedule) {
              const parts = preset.schedule.trim().split(/\s+/);
              schedule = {
                md5: crypto
                  .createHash("md5")
                  .update(preset.schedule)
                  .digest("hex")
              };

              try {
                schedule.duration = +parts.shift() * 1000;
                schedule.schedule = scheduling.parseCron(parts.join(" "));
              } catch (err) {
                logger.warn({
                  message: "Invalid preset schedule",
                  preset: preset._id,
                  schedule: preset.schedule
                });
                schedule.schedule = false;
              }
            }

            const events = preset.events || {};
            const precondition = query.convertMongoQueryToFilters(
              JSON.parse(preset.precondition)
            );
            const _provisions = preset.provisions || [];

            // Generate provisions from the old configuration format
            for (const c of preset.configurations) {
              switch (c.type) {
                case "age":
                  _provisions.push(["refresh", c.name, c.age]);
                  break;

                case "value":
                  _provisions.push(["value", c.name, c.value]);
                  break;

                case "add_tag":
                  _provisions.push(["tag", c.tag, true]);
                  break;

                case "delete_tag":
                  _provisions.push(["tag", c.tag, false]);
                  break;

                case "provision":
                  _provisions.push([c.name].concat(c.args || []));
                  break;

                case "add_object":
                  for (const obj of objects) {
                    if (obj["_id"] === c.object) {
                      const alias = obj["_keys"]
                        .map(k => `${k}:${JSON.stringify(obj[k])}`)
                        .join(",");
                      const p = `${c.name}.[${alias}]`;
                      _provisions.push(["instances", p, 1]);

                      for (const k in obj) {
                        if (
                          !k.startsWith("_") &&
                          !(obj["_keys"].indexOf(k) !== -1)
                        )
                          _provisions.push(["value", `${p}.${k}`, obj[k]]);
                      }
                    }
                  }

                  break;

                case "delete_object":
                  for (const obj of objects) {
                    if (obj["_id"] === c.object) {
                      const alias = obj["_keys"]
                        .map(k => `${k}:${JSON.stringify(obj[k])}`)
                        .join(",");
                      const p = `${c.name}.[${alias}]`;
                      _provisions.push(["instances", p, 0]);
                    }
                  }

                  break;

                default:
                  if (counter & 1)
                    callback(new Error(`Unknown configuration type ${c.type}`));
                  return void (counter = 0);
              }
            }

            presets.push({
              name: preset._id,
              channel: preset.channel || "default",
              schedule: schedule,
              events: events,
              precondition: precondition,
              provisions: _provisions
            });
          }

          if ((counter -= 2) === 1) {
            computeHash();
            cache.set("presets_hash", hash, 300, err => {
              unlockOrExtend(0);
              nextRefresh = now + (REFRESH - (now % REFRESH));
              callback(err);
            });
          }
        });
      });

      counter += 2;
      db.getProvisions((err, res) => {
        if (err) {
          if (counter & 1) callback(err);
          return void (counter = 0);
        }

        provisions = {};
        for (const r of res) {
          provisions[r._id] = {};
          provisions[r._id].md5 = crypto
            .createHash("md5")
            .update(r.script)
            .digest("hex");
          provisions[r._id].script = new vm.Script(
            `"use strict";(function(){\n${r.script}\n})();`,
            { filename: r._id, lineOffset: -1, timeout: 50 }
          );
        }

        if ((counter -= 2) === 1) {
          computeHash();
          cache.set("presets_hash", hash, 300, err => {
            unlockOrExtend(0);
            nextRefresh = now + (REFRESH - (now % REFRESH));
            callback(err);
          });
        }
      });

      counter += 2;
      db.getVirtualParameters((err, res) => {
        if (err) {
          if (counter & 1) callback(err);
          return void (counter = 0);
        }

        virtualParameters = {};
        for (const r of res) {
          virtualParameters[r._id] = {};
          virtualParameters[r._id].md5 = crypto
            .createHash("md5")
            .update(r.script)
            .digest("hex");
          virtualParameters[r._id].script = new vm.Script(
            `"use strict";(function(){\n${r.script}\n})();`,
            { filename: r._id, lineOffset: -1, timeout: 50 }
          );
        }

        if ((counter -= 2) === 1) {
          computeHash();
          cache.set("presets_hash", hash, 300, err => {
            unlockOrExtend(0);
            nextRefresh = now + (REFRESH - (now % REFRESH));
            callback(err);
          });
        }
      });

      counter += 2;
      db.getFiles((err, res) => {
        if (err) {
          if (counter & 1) callback(err);
          return void (counter = 0);
        }

        files = {};
        for (const r of res) {
          const id = r.filename || r._id.toString();
          files[id] = {};
          files[id].length = r.length;
          files[id].md5 = r.md5;
          files[id].contentType = r.contentType;
        }

        if ((counter -= 2) === 1) {
          computeHash();
          cache.set("presets_hash", hash, 300, err => {
            unlockOrExtend(0);
            nextRefresh = now + (REFRESH - (now % REFRESH));
            callback(err);
          });
        }
      });

      if ((counter -= 2) === 1) {
        computeHash();
        cache.set("presets_hash", hash, 300, err => {
          unlockOrExtend(0);
          nextRefresh = now + (REFRESH - (now % REFRESH));
          callback(err);
        });
      }
    });
  });
}

function getPresets(callback) {
  if (Date.now() < nextRefresh) return void callback(null, hash, presets);

  refresh(err => {
    callback(err, hash, presets);
  });
}

function getFiles(callback) {
  if (Date.now() < nextRefresh) return void callback(null, hash, files);

  refresh(err => {
    callback(err, hash, files);
  });
}

function getProvisionsAndVirtualParameters(callback) {
  if (Date.now() < nextRefresh)
    return void callback(null, hash, provisions, virtualParameters);

  refresh(err => {
    callback(err, hash, provisions, virtualParameters);
  });
}

exports.getPresets = getPresets;
exports.getFiles = getFiles;
exports.getProvisionsAndVirtualParameters = getProvisionsAndVirtualParameters;
