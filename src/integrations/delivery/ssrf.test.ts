import { describe, expect, it } from "vitest";
import { isPublicAddress } from "./ssrf";

describe("which addresses a webhook may be at", () => {
  it("allows ordinary public addresses, v4 and v6", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "172.15.255.255", "100.63.255.255", "100.128.0.1", "192.169.0.1", "2606:4700:4700::1111", "2a00:1450:4009:81f::200e"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
  });
  it("refuses loopback, private, link-local (cloud metadata), CGNAT and every reserved IPv4 range", () => {
    for (const address of [
      "0.0.0.0", "0.1.2.3", "10.0.0.1", "10.255.255.255", "127.0.0.1", "127.255.255.254", "169.254.169.254", "169.254.0.1", "172.16.0.1", "172.31.255.255",
      "192.168.0.1", "192.168.255.255", "100.64.0.1", "100.127.255.255", "192.0.0.1", "192.0.2.1", "198.18.0.1", "198.19.255.255", "198.51.100.7", "203.0.113.9",
      "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.88.99.1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
  it("refuses loopback, unspecified, unique-local, link-local, multicast, documentation and Teredo IPv6", () => {
    for (const address of ["::", "::1", "fc00::1", "fd12:3456::1", "fe80::1", "febf::1", "fec0::1", "ff02::1", "2001:db8::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "0:0:0:0:0:0:0:1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
  it("sees through IPv4 hidden inside IPv6 (mapped, compatible, NAT64, 6to4) and judges the embedded address", () => {
    for (const address of ["::ffff:10.0.0.1", "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:a00:1", "::10.0.0.1", "64:ff9b::7f00:1", "64:ff9b::a9fe:a9fe", "2002:a00:1::1", "2002:7f00:1::"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicAddress("64:ff9b::808:808")).toBe(true);
    expect(isPublicAddress("2002:808:808::1")).toBe(true);
  });
  it("refuses anything that is not an IP address, and malformed ones, rather than guessing", () => {
    for (const address of ["", "localhost", "example.com", "1.2.3", "1.2.3.4.5", "256.1.1.1", "::g", "1:2:3:4:5:6:7:8:9", "12345::1", "::1::2", "0x7f.0.0.1", "2130706433", "010.0.0.1"]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });
  it("a zone id does not smuggle a private address through", () => expect(isPublicAddress("fe80::1%eth0")).toBe(false));
});
