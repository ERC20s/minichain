import { isLoopbackHost } from "../src/rpc/server"

describe("isLoopbackHost", () => {
  it("accepts localhost and ::1 and long-form loopback", () => {
    expect(isLoopbackHost("localhost")).toBe(true)
    expect(isLoopbackHost("::1")).toBe(true)
    expect(isLoopbackHost("[::1]")).toBe(true)
    expect(isLoopbackHost("0:0:0:0:0:0:0:1")).toBe(true)
  })

  it("accepts 127.* IPv4 loopback addresses", () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true)
    expect(isLoopbackHost("127.0.0.2")).toBe(true)
    expect(isLoopbackHost("127.255.255.255")).toBe(true)
  })

  it("accepts IPv4-mapped loopback forms in the ::ffff:127.x.x.x range", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackHost("::ffff:127.0.0.2")).toBe(true)
    expect(isLoopbackHost("[::ffff:127.0.0.2]")).toBe(true)
  })

  it("rejects non-loopback and catch-all addresses", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
    expect(isLoopbackHost("::")).toBe(false)
    expect(isLoopbackHost("example.com")).toBe(false)
    expect(isLoopbackHost("")).toBe(false)
  })
})
