import { Readable } from "node:stream"

import { v2 as cloudinary } from "cloudinary"

function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code })
}

export function createCloudinaryStorage({
  env = process.env,
  sdk = cloudinary,
} = {}) {
  function configure() {
    const {
      CLOUDINARY_CLOUD_NAME: cloudName,
      CLOUDINARY_API_KEY: apiKey,
      CLOUDINARY_API_SECRET: apiSecret,
    } = env

    const missing = [
      ["CLOUDINARY_CLOUD_NAME", cloudName],
      ["CLOUDINARY_API_KEY", apiKey],
      ["CLOUDINARY_API_SECRET", apiSecret],
    ]
      .filter(([, value]) => !value)
      .map(([name]) => name)

    if (missing.length) {
      throw httpError(
        503,
        "IMAGE_STORAGE_NOT_CONFIGURED",
        `Promotional image storage is missing server configuration: ${missing.join(", ")}.`,
      )
    }

    sdk.config({
      cloud_name: cloudName,
      api_key: apiKey,
      api_secret: apiSecret,
      secure: true,
    })
  }

  return {
    upload(file, publicId) {
      configure()
      const options = {
        folder: "csc-attendance/promotions",
        resource_type: "image",
        ...(publicId ? { public_id: publicId } : {}),
      }

      return new Promise((resolve, reject) => {
        const uploadStream = sdk.uploader.upload_stream(options, (error, result) => {
          if (error) {
            reject(
              httpError(
                502,
                "IMAGE_STORAGE_FAILED",
                "The image could not be stored. Please try again.",
              ),
            )
            return
          }

          if (
            typeof result?.secure_url !== "string" ||
            !result.secure_url.startsWith("https://") ||
            typeof result.public_id !== "string" ||
            result.public_id.length === 0
          ) {
            reject(
              httpError(
                502,
                "IMAGE_STORAGE_FAILED",
                "Image storage returned an invalid response.",
              ),
            )
            return
          }

          resolve({ imageUrl: result.secure_url, publicId: result.public_id })
        })

        Readable.from(file.data).pipe(uploadStream)
      })
    },

    async delete(publicId) {
      if (!publicId) return
      configure()

      const result = await sdk.uploader.destroy(publicId, {
        resource_type: "image",
        invalidate: true,
      })

      if (!["ok", "not found"].includes(result?.result)) {
        throw httpError(
          502,
          "IMAGE_DELETE_FAILED",
          "The stored image could not be deleted.",
        )
      }
    },
  }
}

const storage = createCloudinaryStorage()

export const cloudinaryUpload = (...args) => storage.upload(...args)
export const cloudinaryDelete = (...args) => storage.delete(...args)
