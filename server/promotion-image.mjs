export const MAX_IMAGE_BYTES = 8 * 1024 * 1024
export const MAX_ACTIVE_PROMOTIONS = 5

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function assertActivePromotionCapacity(activeCount) {
  if (activeCount >= MAX_ACTIVE_PROMOTIONS) {
    throw httpError(
      409,
      "PROMOTION_LIMIT",
      `No more than ${MAX_ACTIVE_PROMOTIONS} promotional images can be active.`,
    )
  }
}

export function validatePromotionImage(file) {
  if (!file?.filename || file.data.length === 0)
    throw httpError(400, "INVALID_IMAGE", "Choose an image file.")

  if (file.data.length > MAX_IMAGE_BYTES)
    throw httpError(413, "IMAGE_TOO_LARGE", "Images must be 8 MB or smaller.")

  const signatures = [
    [
      "image/jpeg",
      file.data[0] === 0xff && file.data[1] === 0xd8 && file.data[2] === 0xff,
    ],
    [
      "image/png",
      file.data
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    ],
    [
      "image/webp",
      file.data.toString("ascii", 0, 4) === "RIFF" &&
        file.data.toString("ascii", 8, 12) === "WEBP",
    ],
  ]

  if (!signatures.some(([mime, matches]) => mime === file.contentType && matches))
    throw httpError(
      400,
      "INVALID_IMAGE",
      "Only valid JPEG, PNG, and WebP images are accepted.",
    )

  return file
}
