const base = String(process.env.AMVEXA_BASE_URL || "").replace(/\/$/, "");
const secret = process.env.PUSH_CRON_SECRET || "";

if (!base || !secret) {
  console.error("Missing AMVEXA_BASE_URL or PUSH_CRON_SECRET");
  process.exit(1);
}

const response = await fetch(base + "/api/push/run", {
  method: "POST",
  headers: {"x-amvexa-cron-secret": secret}
});

const body = await response.text();
console.log(response.status, body);

if (!response.ok) process.exit(1);
