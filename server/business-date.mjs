export function businessDate(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kolkata",

    year: "numeric",

    month: "2-digit",

    day: "2-digit",
  }).format(now)
}
