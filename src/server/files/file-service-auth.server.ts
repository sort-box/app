export async function fileServiceAuthorized(
  request: Request,
  configured: string | undefined
): Promise<boolean> {
  const presented = request.headers.get("x-file-service-secret")
  if (!configured || configured.length < 32 || !presented) return false

  const encode = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))
  const [configuredDigest, presentedDigest] = await Promise.all([
    encode(configured),
    encode(presented),
  ])
  const expected = new Uint8Array(configuredDigest)
  const actual = new Uint8Array(presentedDigest)
  let difference = 0
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected[index] ^ actual[index]
  }
  return difference === 0
}
