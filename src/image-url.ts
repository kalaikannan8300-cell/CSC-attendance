export function cloudinaryDeliveryUrl(source: string, width: number) {
  return source.replace(
    /^(https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/)/,
    `$1f_auto,q_auto,w_${width}/`,
  )
}
