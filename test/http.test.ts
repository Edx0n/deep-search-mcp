import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig, parseTorProxy } from "../src/config.js";
import { HttpClient, HttpError, withoutCredentials } from "../src/http/client.js";
import { assertPublicHost, isPrivateAddress } from "../src/http/ssrf.js";

const ONION = "b".repeat(56) + ".onion";
const ONION_2 = "c".repeat(56) + ".onion";

describe("SSRF guard", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.20.0.1",
    "192.168.0.10",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "fec0::1",
    "::7f00:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::a9fe:a9fe"
  ])("treats %s as private", ip => expect(isPrivateAddress(ip)).toBe(true));

  it.each(["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "64:ff9b::808:808"])("treats %s as public", ip => expect(isPrivateAddress(ip)).toBe(false));

  it("rejects local host names and private IP literals", () => {
    expect(() => assertPublicHost(new URL("http://localhost:3000/"))).toThrow(/local/);
    expect(() => assertPublicHost(new URL("http://printer.local/"))).toThrow(/local/);
    expect(() => assertPublicHost(new URL("http://[::1]/"))).toThrow(/private/);
    expect(() => assertPublicHost(new URL("https://example.com/"))).not.toThrow();
  });

  it("refuses private targets, odd schemes and onions without Tor before any request", async () => {
    const http = new HttpClient(loadConfig({}).config);
    await expect(http.request("http://127.0.0.1:9/")).rejects.toMatchObject({ kind: "blocked" });
    await expect(http.request("http://localhost/")).rejects.toMatchObject({ kind: "blocked" });
    await expect(http.request("file:///etc/passwd")).rejects.toMatchObject({ kind: "blocked" });
    await expect(http.request("https://user:pw@example.com/")).rejects.toMatchObject({ kind: "blocked" });
    await expect(http.request(`http://${ONION}/`)).rejects.toMatchObject({ kind: "tor" });
  });
});

describe("Tor proxy configuration", () => {
  it("parses the accepted forms", () => {
    expect(parseTorProxy("socks5h://127.0.0.1:9050")).toEqual({ host: "127.0.0.1", port: 9050 });
    expect(parseTorProxy("127.0.0.1:9150")).toEqual({ host: "127.0.0.1", port: 9150 });
    expect(parseTorProxy("9150")).toEqual({ host: "127.0.0.1", port: 9150 });
    expect(() => parseTorProxy("http://127.0.0.1:8080")).toThrow(/SOCKS5/);
    expect(() => parseTorProxy("socks5://host")).toThrow(/port/);
  });

  it("warns and disables Tor on invalid values", () => {
    const { config, warnings } = loadConfig({ DEEP_SEARCH_TOR_PROXY: "nonsense://x", DEEP_SEARCH_TIMEOUT_MS: "-5" });
    expect(config.tor).toBeUndefined();
    expect(warnings.join(" ")).toMatch(/SOCKS5/);
    expect(warnings.join(" ")).toMatch(/DEEP_SEARCH_TIMEOUT_MS/);
  });
});

/**
 * Minimal SOCKS5 server standing in for Tor: records the CONNECT target and answers with canned
 * HTTP responses, so we can verify that .onion names are resolved by the proxy (ATYP=domain).
 */
interface SocksCall {
  atyp: number;
  host: string;
  port: number;
  request: string;
}

function startFakeTor(
  respond: (call: SocksCall) => string,
  failFirstConnectTo: ReadonlySet<string> = new Set()
): Promise<{ server: net.Server; port: number; calls: SocksCall[] }> {
  const calls: SocksCall[] = [];
  const failed = new Set<string>();
  const server = net.createServer(socket => {
    let stage = 0;
    let buffer = Buffer.alloc(0);
    let call: SocksCall | undefined;
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (stage === 0 && buffer.length >= 2 && buffer.length >= 2 + buffer[1]!) {
        buffer = buffer.subarray(2 + buffer[1]!);
        socket.write(Buffer.from([0x05, 0x00]));
        stage = 1;
      }
      if (stage === 1 && buffer.length >= 5) {
        const atyp = buffer[3]!;
        let host = "";
        let offset = 4;
        if (atyp === 0x03) {
          const len = buffer[4]!;
          if (buffer.length < 5 + len + 2) return;
          host = buffer.subarray(5, 5 + len).toString();
          offset = 5 + len;
        } else if (atyp === 0x01) {
          host = [...buffer.subarray(4, 8)].join(".");
          offset = 8;
        }
        const port = buffer.readUInt16BE(offset);
        buffer = buffer.subarray(offset + 2);
        call = { atyp, host, port, request: "" };
        calls.push(call);
        if (failFirstConnectTo.has(host) && !failed.has(host)) {
          // Like Tor when a rendezvous circuit cannot be built: SOCKS5 "general failure"
          failed.add(host);
          socket.end(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          stage = 3;
          return;
        }
        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        stage = 2;
      }
      if (stage === 2 && call && buffer.includes("\r\n\r\n")) {
        call.request = buffer.toString();
        socket.end(respond(call));
        stage = 3;
      }
    });
    socket.on("error", () => undefined);
  });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as net.AddressInfo).port, calls })));
}

const httpResponse = (status: string, body: string, extra = "") =>
  `HTTP/1.1 ${status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n${extra}\r\n${body}`;

describe("Tor routing policy (DEEP_SEARCH_TOR_ROUTE)", () => {
  let fake: Awaited<ReturnType<typeof startFakeTor>>;
  const client = (route: string, withProxy = true) =>
    new HttpClient(
      loadConfig({ ...(withProxy ? { DEEP_SEARCH_TOR_PROXY: `socks5h://127.0.0.1:${fake.port}` } : {}), DEEP_SEARCH_TOR_ROUTE: route }).config
    );
  const reached = (host: string) => fake.calls.some(c => c.host === host);

  beforeAll(async () => {
    fake = await startFakeTor(call => httpResponse("200 OK", `via tor to ${call.host}`));
  });

  afterAll(() => {
    fake.server.close();
  });

  it("all: even an academic API call goes through Tor, by name", async () => {
    const response = await client("all").request("http://api.example/works");
    expect(response.viaTor).toBe(true);
    expect(response.text()).toBe("via tor to api.example");
    expect(fake.calls.at(-1)).toMatchObject({ atyp: 0x03, host: "api.example" });
  });

  it("sensitive: marked requests go through Tor, the others go out directly", async () => {
    const http = client("sensitive");
    const response = await http.withDefaults({ sensitive: true }).request("http://pages.example/article");
    expect(response.viaTor).toBe(true);
    expect(reached("pages.example")).toBe(true);
    // Unmarked (academic) requests are not sent to the proxy: this one fails at DNS, directly
    await expect(http.request("http://academic.invalid/")).rejects.toMatchObject({ kind: "network" });
    expect(reached("academic.invalid")).toBe(false);
  });

  it("onion (default): nothing changes for clear-web requests, even marked ones", async () => {
    await expect(client("onion").request("http://marked.invalid/", { sensitive: true })).rejects.toMatchObject({ kind: "network" });
    expect(reached("marked.invalid")).toBe(false);
  });

  it("fails closed: without a proxy, a request that must use Tor never goes out directly", async () => {
    await expect(client("all", false).request("http://api.example/")).rejects.toMatchObject({ kind: "tor" });
    await expect(client("sensitive", false).withDefaults({ sensitive: true }).request("http://pages.example/")).rejects.toThrow(/never directly/);
  });

  it("retries an onion request once after a transient SOCKS failure", async () => {
    const flaky = `${"f".repeat(55)}d.onion`;
    const proxy = await startFakeTor(call => httpResponse("200 OK", `ok from ${call.host}`), new Set([flaky]));
    try {
      const http = new HttpClient(loadConfig({ DEEP_SEARCH_TOR_PROXY: `socks5h://127.0.0.1:${proxy.port}` }).config);
      const response = await http.request(`http://${flaky}/`);
      expect(response.text()).toBe(`ok from ${flaky}`);
      expect(proxy.calls.filter(c => c.host === flaky)).toHaveLength(2);
    } finally {
      proxy.server.close();
    }
  });

  it("reports the route per request", () => {
    expect(client("onion").routesThroughTor({ sensitive: true })).toBe(false);
    expect(client("sensitive").routesThroughTor()).toBe(false);
    expect(client("sensitive").withDefaults({ sensitive: true }).routesThroughTor()).toBe(true);
    expect(client("all").routesThroughTor()).toBe(true);
  });

  it("validates the setting", () => {
    const invalid = loadConfig({ DEEP_SEARCH_TOR_ROUTE: "everything" });
    expect(invalid.config.torRoute).toBe("onion");
    expect(invalid.warnings.join(" ")).toMatch(/DEEP_SEARCH_TOR_ROUTE/);
    expect(loadConfig({ DEEP_SEARCH_TOR_ROUTE: "sensitive" }).warnings.join(" ")).toMatch(/fail instead of going out directly/);
  });
});

describe("routing through Tor (SOCKS5)", () => {
  let fake: Awaited<ReturnType<typeof startFakeTor>>;
  let http: HttpClient;

  beforeAll(async () => {
    fake = await startFakeTor(call => {
      if (call.request.startsWith("GET /redirect")) return httpResponse("302 Found", "", `Location: http://${ONION}/final\r\n`);
      if (call.request.startsWith("GET /to-clearnet")) return httpResponse("302 Found", "", "Location: http://example.com/landing\r\n");
      if (call.request.startsWith("GET /cross-origin")) return httpResponse("302 Found", "", `Location: http://${ONION_2}/landing\r\n`);
      if (call.request.startsWith("GET /same-origin")) return httpResponse("302 Found", "", "Location: /landing-same\r\n");
      if (call.request.startsWith("GET /to-local")) return httpResponse("302 Found", "", "Location: http://127.0.0.1/admin\r\n");
      if (call.request.startsWith("GET /big")) return httpResponse("200 OK", "x".repeat(5000));
      return httpResponse("200 OK", `<h1>hello from ${call.host}</h1>`);
    });
    http = new HttpClient(loadConfig({ DEEP_SEARCH_TOR_PROXY: `socks5h://127.0.0.1:${fake.port}` }).config);
  });

  afterAll(() => {
    fake.server.close();
  });

  it("sends the onion name to the proxy (remote DNS) with the Tor Browser user agent", async () => {
    const response = await http.request(`http://${ONION}/page`);
    expect(response.ok).toBe(true);
    expect(response.viaTor).toBe(true);
    expect(response.text()).toBe(`<h1>hello from ${ONION}</h1>`);
    const call = fake.calls.at(-1)!;
    expect(call.atyp).toBe(0x03);
    expect(call.host).toBe(ONION);
    expect(call.port).toBe(80);
    expect(call.request).toMatch(/user-agent: Mozilla\/5\.0 \(Windows NT 10\.0; rv:140\.0\)/i);
    expect(call.request).toMatch(/accept-language: en-US,en;q=0\.5/i);
  });

  it("still refuses private addresses on hops forced through Tor", async () => {
    await expect(http.request(`http://${ONION}/to-local`)).rejects.toMatchObject({ kind: "blocked" });
    expect(fake.calls.some(c => c.host === "127.0.0.1" || c.atyp === 0x01)).toBe(false);
  });

  it("follows redirects hop by hop", async () => {
    const response = await http.request(`http://${ONION}/redirect`);
    expect(response.url).toBe(`http://${ONION}/final`);
    expect(response.text()).toContain("hello");
  });

  it("returns the 3xx itself in manual mode", async () => {
    const response = await http.request(`http://${ONION}/redirect`, { redirect: "manual" });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`http://${ONION}/final`);
  });

  it("enforces the size limit, or truncates when asked", async () => {
    await expect(http.request(`http://${ONION}/big`, { maxBytes: 1000 })).rejects.toBeInstanceOf(HttpError);
    const truncated = await http.request(`http://${ONION}/big`, { maxBytes: 1000, truncate: true });
    expect(truncated.truncated).toBe(true);
    expect(truncated.body.byteLength).toBe(1000);
  });

  it("stays on Tor when an onion service redirects to the clear web (no IP leak)", async () => {
    const response = await http.request(`http://${ONION}/to-clearnet`);
    expect(response.url).toBe("http://example.com/landing");
    expect(response.viaTor).toBe(true);
    // The clear-web hop went through the proxy too, by name
    expect(fake.calls.at(-1)).toMatchObject({ atyp: 0x03, host: "example.com", port: 80 });
  });

  it("drops API keys and cookies when a redirect leaves the origin", async () => {
    const headers = { authorization: "Bearer SECRET-1", "x-api-key": "SECRET-2", cookie: "s=SECRET-3" };
    await http.request(`http://${ONION}/cross-origin`, { headers });
    const [first, second] = fake.calls.slice(-2);
    expect(first!.request).toContain("SECRET-1");
    expect(second!.host).toBe(ONION_2);
    expect(second!.request).not.toMatch(/SECRET/);
  });

  it("keeps them on same-origin redirects", async () => {
    await http.request(`http://${ONION}/same-origin`, { headers: { authorization: "Bearer SECRET-1" } });
    expect(fake.calls.at(-1)!.request).toContain("SECRET-1");
    expect(withoutCredentials({ Authorization: "a", "X-Api-Key": "b", "API-Key": "c", accept: "d" })).toEqual({ accept: "d" });
  });

  it("explains when the Tor proxy is down", async () => {
    const closed = new HttpClient(loadConfig({ DEEP_SEARCH_TOR_PROXY: "socks5h://127.0.0.1:1" }).config);
    await expect(closed.request(`http://${ONION}/`)).rejects.toThrow(/Tor/);
  });
});
