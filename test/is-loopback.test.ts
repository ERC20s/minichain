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

  it("accepts IPv4-mapped loopback forms in the ::ffff:127.x.x.x range and 32-bit hex form", () => {
    expect(isLoopbackHost("::ffff:127.0.0.1")).toBe(true)
    expect(isLoopbackHost("::ffff:127.0.0.2")).toBe(true)
    expect(isLoopbackHost("[::ffff:127.0.0.2]")).toBe(true)
    // 32-bit hex representation of 127.0.0.1 is 7f000001
    expect(isLoopbackHost("::ffff:7f000001")).toBe(true)
  })

  it("rejects malformed IPv4 and non-loopback addresses", () => {
    // malformed IPv4 should not be accepted even if it superficially looks like 127.*
    expect(isLoopbackHost("127.999.999.999")).toBe(false)
    expect(isLoopbackHost("0.0.0.0")).toBe(false)
    expect(isLoopbackHost("::")).toBe(false)
    expect(isLoopbackHost("example.com")).toBe(false)
    expect(isLoopbackHost("")).toBe(false)
  })
})
