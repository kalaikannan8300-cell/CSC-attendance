function validationError(message) {
  return Object.assign(new Error(message), {
    status: 400,
    code: "VALIDATION_ERROR",
  })
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false

  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(0)
  date.setUTCHours(0, 0, 0, 0)
  date.setUTCFullYear(year, month - 1, day)
  return (
    year >= 1 &&
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  )
}

function validTime(value) {
  return typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
}

export function validateLeaveInput(body) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw validationError("A valid leave object is required.")

  if (!validDate(body.date))
    throw validationError("Leave date must be a valid YYYY-MM-DD date.")

  if (!["staff", "class_closed"].includes(body.scope))
    throw validationError("Choose Staff/Admin Leave or Class Closed.")

  if (!["full_day", "partial_time"].includes(body.leaveType))
    throw validationError("Choose a valid leave type.")

  const reason = typeof body.reason === "string" ? body.reason.trim() : ""
  if (reason.length > 1000)
    throw validationError("Reason must be 1000 characters or fewer.")

  let startTime = null
  let endTime = null
  if (body.leaveType === "partial_time") {
    if (!validTime(body.startTime) || !validTime(body.endTime))
      throw validationError("Provide valid start and end times.")
    if (body.endTime <= body.startTime)
      throw validationError("End time must be later than start time.")
    startTime = body.startTime
    endTime = body.endTime
  }

  return {
    date: body.date,
    scope: body.scope,
    leaveType: body.leaveType,
    reason,
    startTime,
    endTime,
    fullDay: body.leaveType === "full_day",
    affectsAttendance:
      body.scope === "class_closed" && body.leaveType === "full_day",
  }
}

export function leaveDurationMinutes(startTime, endTime) {
  if (!validTime(startTime) || !validTime(endTime) || endTime <= startTime)
    return 0
  const toMinutes = (value) => {
    const [hours, minutes] = value.split(":").map(Number)
    return hours * 60 + minutes
  }
  return toMinutes(endTime) - toMinutes(startTime)
}
