import http from "k6/http";
import { check, sleep } from "k6";
import { Trend } from "k6/metrics";

// Custom metrics
export const redirectLatency = new Trend("redirect_latency");

// Configuration
export const options = {
  stages: [
    { duration: "2m", target: 100 },   // ramp up
    { duration: "5m", target: 100 },   // steady state
    { duration: "2m", target: 500 },   // ramp up
    { duration: "5m", target: 500 },   // steady state
    { duration: "2m", target: 1000 },  // ramp up
    { duration: "5m", target: 1000 },  // stress test
    { duration: "2m", target: 0 },     // ramp down
  ],
  thresholds: {
    redirect_latency: ["p(99)<50ms"],  // p99 latency under 50ms
    http_req_failed: ["rate<0.01"],    // less than 1% failures
  },
};

const BASE_URL = __ENV.BASE_URL || "http://localhost:8080";

// Generate unique short codes for each VU
let codeCounter = 0;

export function setup() {
  // Pre-create some short URLs
  const createdCodes = [];
  for (let i = 0; i < 50; i++) {
    const url = `https://example.com/url-${i}`;
    const payload = JSON.stringify({ url: url });
    const params = { headers: { "Content-Type": "application/json" } };
    const res = http.post(`${BASE_URL}/api/shorten`, payload, params);
    const data = JSON.parse(res.body);
    if (res.status === 200 && data.short_code) {
      createdCodes.push(data.short_code);
    }
  }
  return { createdCodes };
}

export default function(data) {
  // Randomly choose between shortening and resolving
  const type = Math.random() > 0.5 ? "shorten" : "resolve";

  if (type === "shorten") {
    // Create a new short URL
    const url = `https://example.com/url-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    const payload = JSON.stringify({ url: url });
    const params = { headers: { "Content-Type": "application/json" } };
    const res = http.post(`${BASE_URL}/api/shorten`, payload, params);
    
    check(res, {
      "shorten status is 200": (r) => r.status === 200,
    });

    redirectLatency.add(res.timings.duration);
    sleep(0.1);
  } else {
    // Resolve an existing short URL
    // Use a code from the pre-created set or generate one
    const codeIndex = Math.floor(Math.random() * (data.createdCodes.length || 50));
    const code = data.createdCodes[codeIndex] || model.Base62Encode(Math.floor(Math.random() * 1000000));
    
    const res = http.get(`${BASE_URL}/${code}`);
    
    // Measure redirect latency
    redirectLatency.add(res.timings.duration);
    
    check(res, {
      "resolve status is 302": (r) => r.status === 302,
      "location header set": (r) => r.headers["Location"] !== undefined,
    });
    
    sleep(0.1);
  }
}

// Helper module for Base62 encoding
const model = {
  Base62Encode: function(id) {
    const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
    if (id === 0) return chars[0];
    let result = "";
    while (id > 0) {
      result = chars[id % 62] + result;
      id = Math.floor(id / 62);
    }
    return result;
  }
};