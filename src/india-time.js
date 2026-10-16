const indiaTimeZone = "Asia/Kolkata"

export function formatIndiaTime(value) {
  return new Intl.DateTimeFormat("en-IN", {
    timeZone: indiaTimeZone,

    hour: "2-digit",

    minute: "2-digit",

    second: "2-digit",

    hour12: true,
  }).format(new Date(value))
}

export function formatIndiaDate(value) {
  const date =
    typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? new Date(`${value}T00:00:00.000Z`)
      : new Date(value)

  return new Intl.DateTimeFormat("en-IN", {
    timeZone: indiaTimeZone,

    day: "2-digit",

    month: "short",

    year: "numeric",
  }).format(date)
}

export function indiaDateInputValue(value = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: indiaTimeZone,

    year: "numeric",

    month: "2-digit",

    day: "2-digit",
  }).format(value)
}
