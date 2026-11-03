const ID = "claude-setup-token";
const CACHE_MS = 5 * 60 * 1000;
let cached = null;

function tokenOf(auth) {
  return auth?.key || auth?.apiKey || auth?.token || auth?.access || "";
}

function isoFromEpoch(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return new Date(n * 1000).toISOString();
}

async function probe(token) {
  const body = {
    model: "claude-haiku-5-5",
    max_tokens: 1,
    system: "You are Claude Code, Anthropic's official CLI for Claude.",
    messages: [{ role: "user", content: "." }],
  };
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "oauth-2025-04-20",
      "content-type": "application/json",
      "user-agent": "claude-cli/2.1.317 (external, cli)",
    },
    body: JSON.stringify(body),
  });
  const h = res.headers;
  const windows = [];
  const five = h.get("anthropic-ratelimit-unified-5h-utilization");
  const fiveReset = h.get("anthropic-ratelimit-unified-5h-reset");
  const seven = h.get("anthropic-ratelimit-unified-7d-utilization");
  const sevenReset = h.get("anthropic-ratelimit-unified-7d-reset");
  if (five != null) {
    windows.push({
      name: "5 hours",
      used: Number(five) * 100,
      ...(isoFromEpoch(fiveReset) ? { resetsAt: isoFromEpoch(fiveReset) } : {}),
      span: 18000,
    });
  }
  if (seven != null) {
    windows.push({
      name: "7 days",
      used: Number(seven) * 100,
      ...(isoFromEpoch(sevenReset) ? { resetsAt: isoFromEpoch(sevenReset) } : {}),
      span: 604800,
    });
  }
  if (!windows.length) {
    const text = await res.text().catch(() => "");
    throw new Error(`Anthropic returned no quota headers (HTTP ${res.status}) ${text.slice(0, 120)}`);
  }

  const extras = [];
  const fiveStatus = h.get("anthropic-ratelimit-unified-5h-status");
  const sevenStatus = h.get("anthropic-ratelimit-unified-7d-status");
  const statusText = [fiveStatus && `5h ${fiveStatus}`, sevenStatus && `7d ${sevenStatus}`]
    .filter(Boolean)
    .join(" · ");
  if (statusText) extras.push({ name: "Status", display: statusText, aside: true });

  const overage = h.get("anthropic-ratelimit-unified-overage-status");
  const overageWhy = h.get("anthropic-ratelimit-unified-overage-disabled-reason");
  if (overage) {
    extras.push({
      name: "Overage",
      display: overage === "rejected" && overageWhy ? `disabled (${overageWhy})` : overage,
      aside: true,
    });
  }

  const fallback = h.get("anthropic-ratelimit-unified-fallback");
  const fallbackPct = h.get("anthropic-ratelimit-unified-fallback-percentage");
  if (fallback) {
    extras.push({
      name: "Fallback",
      display: fallbackPct ? `${fallback} (${Math.round(Number(fallbackPct) * 100)}%)` : fallback,
      aside: true,
    });
  }

  return { plan: "Pro", user: "Claude setup-token", windows: [...windows, ...extras], signIn: "kept" };
}

export default async function () {
  return {
    async config(config) {
      config.provider ??= {};
      const was = config.provider[ID] ?? {};
      config.provider[ID] = {
        name: "Claude Setup Token",
        npm: "@ai-sdk/anthropic",
        api: "https://api.anthropic.com",
        ...was,
        models: {},
      };
    },

    auth: {
      provider: ID,
      methods: [{ type: "api", label: "Claude setup-token" }],

      async loader(getAuth) {
        const auth = await getAuth();
        const token = tokenOf(auth);
        return {
          baseURL: "https://api.anthropic.com",
          apiKey: token || "unused",
          async fetch() {
            return new Response(
              JSON.stringify({ error: { message: "This provider is for quota display only" } }),
              { status: 501, headers: { "content-type": "application/json" } },
            );
          },
        };
      },

      async usage(getAuth) {
        if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
        const auth = await getAuth();
        const token = tokenOf(auth);
        if (!token) return { error: "no setup-token", windows: [], signIn: "kept" };
        try {
          const value = await probe(token);
          cached = { at: Date.now(), value };
          return value;
        } catch (e) {
          return { error: String(e?.message || e), windows: [], signIn: "kept" };
        }
      },
    },

    provider: {
      id: ID,
      async models() {
        return {};
      },
    },
  };
}
