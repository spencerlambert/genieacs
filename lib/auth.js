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

const crypto = require("crypto");

function parseAuthHeader(authHeader) {
  authHeader = authHeader.trim();
  const method = authHeader.split(" ", 1)[0];
  const res = { method: method };
  const parts = authHeader.slice(method.length + 1).split(",");

  let part;
  while ((part = parts.shift()) != null) {
    const name = part.split("=", 1)[0];
    if (name.length === part.length)
      throw new Error("Unable to parse auth header");

    let value = part.slice(name.length + 1);
    if (!/^\s*"/.test(value)) {
      value = value.trim();
    } else {
      while (!/[^\\]"\s*$/.test(value)) {
        const p = parts.shift();
        if (p == null) throw new Error("Unable to parse auth header");
        value += "," + p;
      }

      try {
        value = JSON.parse(value);
      } catch (error) {
        throw new Error("Unable to parse auth header");
      }
    }
    res[name.trim()] = value;
  }
  return res;
}

function basic(username, password) {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

function digest(username, password, uri, httpMethod, body, authHeader) {
  const cnonce = "0a4f113b";
  const nc = "00000001";
  let qop;

  if (authHeader.qop) {
    if (authHeader.qop.indexOf(",") !== -1) qop = "auth";
    // Either auth or auth-int, prefer auth
    else qop = authHeader.qop;
  }

  let ha1 = crypto.createHash("md5");
  ha1
    .update(username)
    .update(":")
    .update(authHeader.realm)
    .update(":")
    .update(password);
  // TODO support "MD5-sess" algorithm directive
  ha1 = ha1.digest("hex");

  let ha2 = crypto.createHash("md5");
  ha2
    .update(httpMethod)
    .update(":")
    .update(uri);
  if (qop === "auth-int") ha2.update(":").update(body);
  ha2 = ha2.digest("hex");

  const hash = crypto.createHash("md5");
  hash
    .update(ha1)
    .update(":")
    .update(authHeader.nonce);
  if (qop) {
    hash
      .update(":")
      .update(nc)
      .update(":")
      .update(cnonce)
      .update(":")
      .update(qop);
  }
  hash.update(":").update(ha2);

  let authString = `Digest username="${username}"`;
  authString += `,realm="${authHeader.realm}"`;
  authString += `,nonce="${authHeader.nonce}"`;
  authString += `,uri="${uri}"`;
  if (authHeader.algorithm) authString += `,algorithm=${authHeader.algorithm}`;
  if (qop) authString += `,qop=${qop},nc=${nc},cnonce="${cnonce}"`;
  authString += `,response="${hash.digest("hex")}"`;
  if (authHeader.opaque) authString += `,opaque="${authHeader.opaque}"`;

  return authString;
}

exports.parseAuthHeader = parseAuthHeader;
exports.basic = basic;
exports.digest = digest;
