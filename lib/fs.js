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

const url = require("url");
const querystring = require("querystring");
const mongodb = require("mongodb");
const db = require("./db");

function listener(request, response) {
  const urlParts = url.parse(request.url, true);
  if (request.method === "GET") {
    const filename = querystring.unescape(urlParts.pathname.substring(1));
    const gs = new mongodb.GridStore(db.mongoDb, filename, "r", {});
    gs.open(err => {
      if (err) {
        response.writeHead(404);
        response.end();
        return;
      }
      const stream = gs.stream(true);
      response.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": gs.length
      });
      stream.pipe(response);
    });
  } else {
    response.writeHead(405, { Allow: "GET" });
    response.end("405 Method Not Allowed");
  }
}

exports.listener = listener;
