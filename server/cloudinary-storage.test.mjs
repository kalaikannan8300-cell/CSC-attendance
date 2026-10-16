import assert from "node:assert/strict"
import { Writable } from "node:stream"
import { test } from "node:test"

import { createCloudinaryStorage } from "./cloudinary-storage.mjs"
import {
  assertActivePromotionCapacity,
  MAX_IMAGE_BYTES,
  validatePromotionImage,
} from "./promotion-image.mjs"

const configuredEnv = {
  CLOUDINARY_CLOUD_NAME: "test-cloud",
  CLOUDINARY_API_KEY: "test-key",
  CLOUDINARY_API_SECRET: "test-secret",
}

const pngFile = () => ({
  filename: "banner.png",
  contentType: "image/png",
  data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
})

test("Cloudinary storage reports missing server variable names without values", async () => {
  const storage = createCloudinaryStorage({
    env: { ...configuredEnv, CLOUDINARY_API_SECRET: "" },
    sdk: { config() {}, uploader: {} },
  })

  assert.throws(() => storage.upload(pngFile()), (error) => {
    assert.equal(error.status, 503)
    assert.equal(error.code, "IMAGE_STORAGE_NOT_CONFIGURED")
    assert.match(error.message, /CLOUDINARY_API_SECRET/)
    assert.equal(error.message.includes(configuredEnv.CLOUDINARY_CLOUD_NAME), false)
    assert.equal(error.message.includes(configuredEnv.CLOUDINARY_API_KEY), false)
    return true
  })
})

test("Cloudinary SDK upload returns only validated secure metadata", async () => {
  let config
  let options
  let uploadedBytes = 0
  const sdk = {
    config(value) {
      config = value
    },
    uploader: {
      upload_stream(uploadOptions, callback) {
        options = uploadOptions
        return new Writable({
          write(chunk, _encoding, done) {
            uploadedBytes += chunk.length
            done()
          },
          final(done) {
            callback(null, {
              secure_url: "https://res.cloudinary.com/test/image/upload/banner.png",
              public_id: "csc-attendance/promotions/banner",
            })
            done()
          },
        })
      },
    },
  }
  const storage = createCloudinaryStorage({ env: configuredEnv, sdk })
  const result = await storage.upload(pngFile())

  assert.equal(config.cloud_name, configuredEnv.CLOUDINARY_CLOUD_NAME)
  assert.equal(config.api_key, configuredEnv.CLOUDINARY_API_KEY)
  assert.equal(config.api_secret, configuredEnv.CLOUDINARY_API_SECRET)
  assert.equal(options.resource_type, "image")
  assert.equal(options.folder, "csc-attendance/promotions")
  assert.equal(uploadedBytes, pngFile().data.length)
  assert.deepEqual(result, {
    imageUrl: "https://res.cloudinary.com/test/image/upload/banner.png",
    publicId: "csc-attendance/promotions/banner",
  })
})

test("Cloudinary upload failures are mapped to a generic storage error", async () => {
  const sdk = {
    config() {},
    uploader: {
      upload_stream(_options, callback) {
        return new Writable({
          write(_chunk, _encoding, done) {
            done()
          },
          final(done) {
            callback(new Error("provider error must not be exposed"))
            done()
          },
        })
      },
    },
  }
  const storage = createCloudinaryStorage({ env: configuredEnv, sdk })

  await assert.rejects(storage.upload(pngFile()), (error) => {
    assert.equal(error.code, "IMAGE_STORAGE_FAILED")
    assert.equal(error.message.includes("provider error"), false)
    return true
  })
})

test("Cloudinary deletion uses the SDK only for database-referenced asset IDs", async () => {
  const deleted = []
  const sdk = {
    config() {},
    uploader: {
      async destroy(publicId, options) {
        deleted.push({ publicId, options })
        return { result: "ok" }
      },
    },
  }
  const storage = createCloudinaryStorage({ env: configuredEnv, sdk })

  await storage.delete("csc-attendance/promotions/known-asset")
  assert.deepEqual(deleted, [
    {
      publicId: "csc-attendance/promotions/known-asset",
      options: { resource_type: "image", invalidate: true },
    },
  ])
})

test("promotion images accept JPEG, PNG, and WebP only and enforce the 8 MB limit", () => {
  assert.doesNotThrow(() =>
    validatePromotionImage({
      filename: "photo.png",
      contentType: "image/png",
      data: pngFile().data,
    }),
  )
  assert.throws(
    () =>
      validatePromotionImage({
        filename: "animation.gif",
        contentType: "image/gif",
        data: Buffer.from("GIF89a"),
      }),
    { code: "INVALID_IMAGE" },
  )
  assert.throws(
    () =>
      validatePromotionImage({
        filename: "large.png",
        contentType: "image/png",
        data: Buffer.alloc(MAX_IMAGE_BYTES + 1),
      }),
    { code: "IMAGE_TOO_LARGE" },
  )
})

test("active promotion cap allows five and rejects adding a sixth active image", () => {
  assert.doesNotThrow(() => assertActivePromotionCapacity(4))
  assert.throws(() => assertActivePromotionCapacity(5), {
    code: "PROMOTION_LIMIT",
  })
})
