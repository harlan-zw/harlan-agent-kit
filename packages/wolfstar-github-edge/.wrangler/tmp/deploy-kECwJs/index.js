var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// ../../node_modules/.pnpm/@cloudflare+containers@0.3.7/node_modules/@cloudflare/containers/dist/lib/helpers.js
function generateId(length = 9) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += alphabet[bytes[i] % alphabet.length];
  }
  return result;
}
__name(generateId, "generateId");
function parseTimeExpression(timeExpression) {
  if (typeof timeExpression === "number") {
    return timeExpression;
  }
  if (typeof timeExpression === "string") {
    const match = timeExpression.match(/^(\d+)([smh])$/);
    if (!match) {
      throw new Error(`invalid time expression ${timeExpression}`);
    }
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
      case "s":
        return value;
      case "m":
        return value * 60;
      case "h":
        return value * 60 * 60;
      default:
        throw new Error(`unknown time unit ${unit}`);
    }
  }
  throw new Error(`invalid type for a time expression: ${typeof timeExpression}`);
}
__name(parseTimeExpression, "parseTimeExpression");

// ../../node_modules/.pnpm/@cloudflare+containers@0.3.7/node_modules/@cloudflare/containers/dist/lib/container.js
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
var NO_CONTAINER_INSTANCE_ERROR = "there is no container instance that can be provided to this durable object";
var RATE_LIMITED_ERROR = "you are requesting too many containers per second";
var RUNTIME_SIGNALLED_ERROR = "runtime signalled the container to exit:";
var UNEXPECTED_EXIT_ERROR = "container exited with unexpected exit code:";
var NOT_LISTENING_ERROR = "the container is not listening";
var CONTAINER_STATE_KEY = "__CF_CONTAINER_STATE";
var OUTBOUND_CONFIGURATION_KEY = "OUTBOUND_CONFIGURATION";
var MAX_ALARM_RETRIES = 3;
var PING_TIMEOUT_MS = 5e3;
var DEFAULT_SLEEP_AFTER = "10m";
var INSTANCE_POLL_INTERVAL_MS = 300;
var TIMEOUT_TO_GET_CONTAINER_MS = 8e3;
var TIMEOUT_TO_GET_PORTS_MS = 2e4;
var FALLBACK_PORT_TO_CHECK = 33;
var outboundHandlersRegistry = /* @__PURE__ */ new Map();
var defaultOutboundHandlerNameRegistry = /* @__PURE__ */ new Map();
var outboundByHostRegistry = /* @__PURE__ */ new Map();
var signalToNumbers = {
  SIGINT: 2,
  SIGTERM: 15,
  SIGKILL: 9
};
function isErrorOfType(e, matchingString) {
  const errorString = e instanceof Error ? e.message : String(e);
  return errorString.toLowerCase().includes(matchingString);
}
__name(isErrorOfType, "isErrorOfType");
var isNoInstanceError = /* @__PURE__ */ __name((error) => isErrorOfType(error, NO_CONTAINER_INSTANCE_ERROR), "isNoInstanceError");
var isRateLimitedError = /* @__PURE__ */ __name((error) => isErrorOfType(error, RATE_LIMITED_ERROR), "isRateLimitedError");
var isRuntimeSignalledError = /* @__PURE__ */ __name((error) => isErrorOfType(error, RUNTIME_SIGNALLED_ERROR), "isRuntimeSignalledError");
var isNotListeningError = /* @__PURE__ */ __name((error) => isErrorOfType(error, NOT_LISTENING_ERROR), "isNotListeningError");
var isContainerExitNonZeroError = /* @__PURE__ */ __name((error) => isErrorOfType(error, UNEXPECTED_EXIT_ERROR), "isContainerExitNonZeroError");
function getExitCodeFromError(error) {
  if (!(error instanceof Error)) {
    return null;
  }
  if (isRuntimeSignalledError(error)) {
    return +error.message.toLowerCase().slice(error.message.toLowerCase().indexOf(RUNTIME_SIGNALLED_ERROR) + RUNTIME_SIGNALLED_ERROR.length + 1);
  }
  if (isContainerExitNonZeroError(error)) {
    return +error.message.toLowerCase().slice(error.message.toLowerCase().indexOf(UNEXPECTED_EXIT_ERROR) + UNEXPECTED_EXIT_ERROR.length + 1);
  }
  return null;
}
__name(getExitCodeFromError, "getExitCodeFromError");
function addTimeoutSignal(existingSignal, timeoutMs) {
  const controller2 = new AbortController();
  if (existingSignal?.aborted) {
    controller2.abort();
    return controller2.signal;
  }
  existingSignal?.addEventListener("abort", () => controller2.abort());
  const timeoutId = setTimeout(() => controller2.abort(), timeoutMs);
  controller2.signal.addEventListener("abort", () => clearTimeout(timeoutId));
  return controller2.signal;
}
__name(addTimeoutSignal, "addTimeoutSignal");
function simpleGlobMatch(pattern, value) {
  const parts = pattern.split("*");
  if (parts.length === 1)
    return pattern === value;
  if (!value.startsWith(parts[0]))
    return false;
  if (!value.endsWith(parts[parts.length - 1]))
    return false;
  let pos = parts[0].length;
  for (let i = 1; i < parts.length - 1; i++) {
    const idx = value.indexOf(parts[i], pos);
    if (idx === -1)
      return false;
    pos = idx + parts[i].length;
  }
  return pos <= value.length - parts[parts.length - 1].length;
}
__name(simpleGlobMatch, "simpleGlobMatch");
function matchesHostList(hostname, patterns) {
  return patterns.some((pattern) => simpleGlobMatch(pattern, hostname));
}
__name(matchesHostList, "matchesHostList");
function normalizeHostname(hostname) {
  let end = hostname.length;
  while (end > 0 && hostname[end - 1] === ".") {
    end--;
  }
  return hostname.slice(0, end);
}
__name(normalizeHostname, "normalizeHostname");
var ContainerState = class {
  static {
    __name(this, "ContainerState");
  }
  storage;
  status;
  constructor(storage) {
    this.storage = storage;
  }
  async setRunning() {
    await this.setStatusAndupdate("running");
  }
  async setHealthy() {
    await this.setStatusAndupdate("healthy");
  }
  async setStopping() {
    await this.setStatusAndupdate("stopping");
  }
  async setStopped() {
    await this.setStatusAndupdate("stopped");
  }
  async setStoppedIfUnchanged(previousState) {
    if (this.status !== previousState) {
      return;
    }
    await this.setStopped();
  }
  async setStoppedWithCode(exitCode) {
    this.status = { status: "stopped_with_code", lastChange: Date.now(), exitCode };
    await this.update();
  }
  async getState() {
    if (!this.status) {
      const state = await this.storage.get(CONTAINER_STATE_KEY);
      if (!state) {
        this.status = {
          status: "stopped",
          lastChange: Date.now()
        };
        await this.update();
      } else {
        this.status = state;
      }
    }
    return this.status;
  }
  async setStatusAndupdate(status) {
    this.status = { status, lastChange: Date.now() };
    await this.update();
  }
  async update() {
    if (!this.status)
      throw new Error("status should be init");
    await this.storage.put(CONTAINER_STATE_KEY, this.status);
  }
};
var ContainerProxy = class extends WorkerEntrypoint {
  static {
    __name(this, "ContainerProxy");
  }
  async fetch(request) {
    const url = new URL(request.url);
    const hostname = normalizeHostname(url.hostname);
    const { className, containerId, outboundByHostOverrides, outboundHandlerOverride, enableInternet, allowedHosts, deniedHosts, interceptAll } = this.ctx.props;
    const baseCtx = { containerId, className };
    if (deniedHosts && matchesHostList(hostname, deniedHosts)) {
      return new Response("Origin is disallowed", { status: 520 });
    }
    if (allowedHosts && !matchesHostList(hostname, allowedHosts)) {
      return new Response("Origin is disallowed", { status: 520 });
    }
    const handlers = outboundHandlersRegistry.get(className);
    if (outboundByHostOverrides && handlers) {
      const override = outboundByHostOverrides[hostname] ?? Object.entries(outboundByHostOverrides).find(([pattern]) => pattern !== hostname && simpleGlobMatch(pattern, hostname))?.[1];
      if (override && handlers[override.method]) {
        return handlers[override.method](request, this.env, {
          ...baseCtx,
          params: override.params
        });
      }
    }
    const handlersByHost = outboundByHostRegistry.get(className);
    if (handlersByHost) {
      const handler = handlersByHost[hostname] ?? Object.entries(handlersByHost).find(([pattern]) => pattern !== hostname && simpleGlobMatch(pattern, hostname))?.[1];
      if (handler) {
        return handler(request, this.env, baseCtx);
      }
    }
    if (!interceptAll) {
      if (allowedHosts || enableInternet) {
        return fetch(request);
      }
      return new Response("Origin is disallowed", { status: 520 });
    }
    if (outboundHandlerOverride && handlers?.[outboundHandlerOverride.method]) {
      return handlers[outboundHandlerOverride.method](request, this.env, {
        ...baseCtx,
        params: outboundHandlerOverride.params
      });
    }
    const defaultOutboundHandlerName = defaultOutboundHandlerNameRegistry.get(className);
    if (defaultOutboundHandlerName && handlers?.[defaultOutboundHandlerName]) {
      return handlers[defaultOutboundHandlerName](request, this.env, baseCtx);
    }
    if (allowedHosts) {
      return fetch(request);
    }
    if (enableInternet) {
      return fetch(request);
    }
    return new Response("Origin is disallowed", { status: 520 });
  }
};
var Container = class extends DurableObject {
  static {
    __name(this, "Container");
  }
  static get outboundByHost() {
    return outboundByHostRegistry.get(this.name);
  }
  static set outboundByHost(handlers) {
    outboundByHostRegistry.set(this.name, handlers);
  }
  static get outboundHandlers() {
    return outboundHandlersRegistry.get(this.name);
  }
  static set outboundHandlers(handlers) {
    const existing = outboundHandlersRegistry.get(this.name) ?? {};
    outboundHandlersRegistry.set(this.name, { ...existing, ...handlers });
  }
  static get outbound() {
    const handlerName = defaultOutboundHandlerNameRegistry.get(this.name);
    if (!handlerName)
      return void 0;
    return outboundHandlersRegistry.get(this.name)?.[handlerName];
  }
  static set outbound(handler) {
    const key = "__outbound__";
    const existing = outboundHandlersRegistry.get(this.name) ?? {};
    outboundHandlersRegistry.set(this.name, { ...existing, [key]: handler });
    defaultOutboundHandlerNameRegistry.set(this.name, key);
  }
  static get outboundProxies() {
    return this.outboundHandlers;
  }
  static set outboundProxies(handlers) {
    this.outboundHandlers = handlers;
  }
  static get outboundProxy() {
    return this.outbound;
  }
  static set outboundProxy(handler) {
    this.outbound = handler;
  }
  // =========================
  //     Public Attributes
  // =========================
  // Default port for the container (undefined means no default port)
  defaultPort;
  // Required ports that should be checked for availability during container startup
  // Override this in your subclass to specify ports that must be ready
  requiredPorts;
  // Timeout after which the container will sleep if no activity
  // The signal sent to the container by default is a SIGTERM.
  // The container won't get a SIGKILL if this threshold is triggered.
  sleepAfter = DEFAULT_SLEEP_AFTER;
  // Container configuration properties
  // Set these properties directly in your container instance
  envVars = {};
  entrypoint;
  enableInternet = true;
  labels = {};
  // When true, outbound HTTPS traffic from the container will be intercepted.
  // The container must trust /etc/cloudflare/certs/cloudflare-containers-ca.crt
  interceptHttps = false;
  // Hosts that are allowed to access the internet, even when enableInternet is false.
  // Useful for allowing specific domains on a per-host basis.
  allowedHosts;
  // Hosts that are denied internet access, even when enableInternet is true.
  // Also blocks hosts from being handled by the catch-all outbound handler.
  deniedHosts;
  // pingEndpoint is the host and path value that the class will use to send a request to the container and check if the
  // instance is ready.
  //
  // The user does not have to implement this route by any means,
  // but it's still useful if you want to control the path that
  // the Container class uses to send HTTP requests to.
  pingEndpoint = "ping";
  applyOutboundInterceptionPromise = Promise.resolve();
  usingInterception = false;
  // =========================
  //     PUBLIC INTERFACE
  // =========================
  constructor(ctx, env, options) {
    super(ctx, env);
    if (ctx.container === void 0) {
      throw new Error("Containers have not been enabled for this Durable Object class. Have you correctly setup your Wrangler config? More info: https://developers.cloudflare.com/containers/get-started/#configuration");
    }
    this.state = new ContainerState(this.ctx.storage);
    const persistedOutboundConfiguration = this.restoreOutboundConfiguration();
    this.ctx.blockConcurrencyWhile(async () => {
      await this.scheduleNextAlarm();
      this.renewActivityTimeout();
      const ctor = this.constructor;
      if (persistedOutboundConfiguration !== void 0 || ctor.outboundByHost !== void 0 || ctor.outbound !== void 0 || ctor.outboundHandlers !== void 0 || this.effectiveAllowedHosts !== void 0 || this.effectiveDeniedHosts !== void 0) {
        this.usingInterception = true;
      }
      if (this.container.running) {
        this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
      }
    });
    this.container = ctx.container;
    if (options) {
      if (options.defaultPort !== void 0)
        this.defaultPort = options.defaultPort;
      if (options.sleepAfter !== void 0)
        this.sleepAfter = options.sleepAfter;
      if (options.envVars !== void 0)
        this.envVars = options.envVars;
      if (options.entrypoint !== void 0)
        this.entrypoint = options.entrypoint;
      if (options.enableInternet !== void 0)
        this.enableInternet = options.enableInternet;
    }
    this.sql`
      CREATE TABLE IF NOT EXISTS container_schedules (
        id TEXT PRIMARY KEY NOT NULL DEFAULT (randomblob(9)),
        callback TEXT NOT NULL,
        payload TEXT,
        type TEXT NOT NULL CHECK(type IN ('scheduled', 'delayed')),
        time INTEGER NOT NULL,
        delayInSeconds INTEGER,
        created_at INTEGER DEFAULT (unixepoch())
      )
    `;
    if (this.container.running) {
      this.monitor = this.container.monitor();
      this.setupMonitorCallbacks();
    }
  }
  /**
   * Gets the current state of the container
   * @returns Promise<State>
   */
  async getState() {
    return { ...await this.state.getState() };
  }
  // ====================================
  //     OUTBOUND INTERCEPTION CONFIG
  // ====================================
  /**
   * Set the catch-all outbound handler to a named method from `outboundHandlers`.
   * Overrides the default `outbound` at runtime via ContainerProxy props.
   *
   * @param methodName - Name of a method defined in `static outboundHandlers`
   * @param params - Optional params passed to the handler as `ctx.params`
   * @throws Error if the method name is not found in `outboundHandlers`
   */
  async setOutboundHandler(methodName, ...paramsArg) {
    this.validateOutboundHandlerMethodName(methodName);
    this.outboundHandlerOverride = paramsArg.length === 0 ? { method: methodName } : { method: methodName, params: paramsArg[0] };
    await this.refreshOutboundInterception();
  }
  /**
   * Add or override a hostname-specific outbound handler at runtime,
   * referencing a named method from `outboundHandlers`.
   * Overrides any matching entry in `static outboundByHost` for this hostname.
   *
   * @param hostname - The hostname or ip:port to intercept (e.g. `'google.com'`)
   * @param methodName - Name of a method defined in `static outboundHandlers`
   * @param params - Optional params passed to the handler as `ctx.params`
   * @throws Error if the method name is not found in `outboundHandlers`
   */
  async setOutboundByHost(hostname, methodName, ...paramsArg) {
    this.validateOutboundHandlerMethodName(methodName);
    this.outboundByHostOverrides[hostname] = paramsArg.length === 0 ? { method: methodName } : { method: methodName, params: paramsArg[0] };
    await this.refreshOutboundInterception();
  }
  /**
   * Remove a runtime hostname override added via `setOutboundByHost`.
   * The default handler from `static outboundByHost` (if any) will be used again.
   *
   * @param hostname - The hostname or ip:port to stop overriding
   */
  async removeOutboundByHost(hostname) {
    delete this.outboundByHostOverrides[hostname];
    await this.refreshOutboundInterception();
  }
  /**
   * Replace all runtime hostname overrides at once.
   * Each value may be either a method name or an object with `method` and `params`.
   *
   * @param handlers - Record mapping hostnames to handler configs in `outboundHandlers`
   * @throws Error if any method name is not found in `outboundHandlers`
   */
  async setOutboundByHosts(handlers) {
    for (const handler of Object.values(handlers)) {
      const methodName = typeof handler === "string" ? handler : handler.method;
      this.validateOutboundHandlerMethodName(methodName);
    }
    this.outboundByHostOverrides = Object.fromEntries(Object.entries(handlers).map(([hostname, handler]) => [
      hostname,
      typeof handler === "string" ? { method: handler } : handler
    ]));
    await this.refreshOutboundInterception();
  }
  // ====================================
  //     ALLOWED / DENIED HOSTS CONFIG
  // ====================================
  /**
   * Replace all allowed hosts at runtime.
   * Allowed hosts get internet access even when `enableInternet` is false.
   *
   * @param hosts - Array of hostnames to allow (e.g. `['api.stripe.com', 'example.com']`)
   */
  async setAllowedHosts(hosts) {
    this.allowedHostsOverride = [...hosts];
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Replace all denied hosts at runtime.
   * Denied hosts are blocked unconditionally, even when `enableInternet` is true
   * or a catch-all outbound handler is set.
   *
   * @param hosts - Array of hostnames to deny (e.g. `['evil.com', 'blocked.org']`)
   */
  async setDeniedHosts(hosts) {
    this.deniedHostsOverride = [...hosts];
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Add a single hostname to the allowed hosts list at runtime.
   *
   * @param hostname - The hostname to allow (e.g. `'api.stripe.com'`)
   */
  async allowHost(hostname) {
    const effective = this.effectiveAllowedHosts ?? [];
    if (!effective.includes(hostname)) {
      this.allowedHostsOverride = [...effective, hostname];
    }
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Add a single hostname to the denied hosts list at runtime.
   *
   * @param hostname - The hostname to deny (e.g. `'evil.com'`)
   */
  async denyHost(hostname) {
    const effective = this.effectiveDeniedHosts ?? [];
    if (!effective.includes(hostname)) {
      this.deniedHostsOverride = [...effective, hostname];
    }
    this.usingInterception = true;
    await this.refreshOutboundInterception();
  }
  /**
   * Remove a hostname from the allowed hosts list.
   *
   * @param hostname - The hostname to remove from the allow list
   */
  async removeAllowedHost(hostname) {
    this.allowedHostsOverride = (this.effectiveAllowedHosts ?? []).filter((h) => h !== hostname);
    await this.refreshOutboundInterception();
  }
  /**
   * Remove a hostname from the denied hosts list.
   *
   * @param hostname - The hostname to remove from the deny list
   */
  async removeDeniedHost(hostname) {
    this.deniedHostsOverride = (this.effectiveDeniedHosts ?? []).filter((h) => h !== hostname);
    await this.refreshOutboundInterception();
  }
  // ==========================
  //     CONTAINER STARTING
  // ==========================
  /**
   * Start the container if it's not running and set up monitoring and lifecycle hooks,
   * without waiting for ports to be ready.
   *
   * It will automatically retry if the container fails to start, using the specified waitOptions
   *
   *
   * @example
   * await this.start({
   *   envVars: { DEBUG: 'true', NODE_ENV: 'development' },
   *   entrypoint: ['npm', 'run', 'dev'],
   *   enableInternet: false,
   *   labels: { tenant: 'acme', env: 'prod' },
   * });
   *
   * @param startOptions - Override `envVars`, `entrypoint`, `enableInternet` and `labels` on a per-instance basis
   * @param waitOptions - Optional wait configuration with abort signal for cancellation. Default ~8s timeout.
   * @returns A promise that resolves when the container start command has been issued
   * @throws Error if no container context is available or if all start attempts fail
   */
  async start(startOptions, waitOptions) {
    const portToCheck = waitOptions?.portToCheck ?? this.defaultPort ?? (this.requiredPorts ? this.requiredPorts[0] : FALLBACK_PORT_TO_CHECK);
    const pollInterval = waitOptions?.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    await this.startContainerIfNotRunning({
      signal: waitOptions?.signal,
      waitInterval: pollInterval,
      retries: waitOptions?.retries ?? Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / pollInterval),
      portToCheck
    }, startOptions);
    this.setupMonitorCallbacks();
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.onStart();
    });
  }
  async startAndWaitForPorts(portsOrArgs, cancellationOptions, startOptions) {
    let ports;
    let resolvedCancellationOptions;
    let resolvedStartOptions;
    if (typeof portsOrArgs === "object" && portsOrArgs !== null && !Array.isArray(portsOrArgs)) {
      ports = portsOrArgs.ports;
      resolvedCancellationOptions = portsOrArgs.cancellationOptions;
      resolvedStartOptions = portsOrArgs.startOptions;
    } else {
      ports = portsOrArgs;
      resolvedCancellationOptions = cancellationOptions;
      resolvedStartOptions = startOptions;
    }
    const portsToCheck = await this.getPortsToCheck(ports);
    await this.syncPendingStoppedEvents();
    resolvedCancellationOptions ??= {};
    const containerGetTimeout = resolvedCancellationOptions.instanceGetTimeoutMS ?? TIMEOUT_TO_GET_CONTAINER_MS;
    const pollInterval = resolvedCancellationOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const containerGetRetries = Math.ceil(containerGetTimeout / pollInterval);
    const waitOptions = {
      signal: resolvedCancellationOptions.abort,
      retries: containerGetRetries,
      waitInterval: pollInterval,
      portToCheck: portsToCheck[0]
    };
    const triesUsed = await this.startContainerIfNotRunning(waitOptions, resolvedStartOptions);
    const totalPortReadyTries = Math.ceil((resolvedCancellationOptions.portReadyTimeoutMS ?? TIMEOUT_TO_GET_PORTS_MS) / pollInterval);
    let triesLeft = totalPortReadyTries - triesUsed;
    for (const port of portsToCheck) {
      triesLeft = await this.waitForPort({
        signal: resolvedCancellationOptions.abort,
        waitInterval: pollInterval,
        retries: triesLeft,
        portToCheck: port
      });
    }
    this.setupMonitorCallbacks();
    await this.ctx.blockConcurrencyWhile(async () => {
      await this.state.setHealthy();
      await this.onStart();
    });
  }
  /**
   *
   * Waits for a specified port to be ready
   *
   * Returns the number of tries used to get the port, or throws if it couldn't get the port within the specified retry limits.
   *
   * @param waitOptions -
   * - `portToCheck`: The port number to check
   * - `abort`: Optional AbortSignal to cancel waiting
   * - `retries`: Number of retries before giving up (default: TRIES_TO_GET_PORTS)
   * - `waitInterval`: Interval between retries in milliseconds (default: INSTANCE_POLL_INTERVAL_MS)
   */
  async waitForPort(waitOptions) {
    const port = waitOptions.portToCheck;
    const tcpPort = this.container.getTcpPort(port);
    const abortedSignal = new Promise((res) => {
      waitOptions.signal?.addEventListener("abort", () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const tries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_PORTS_MS / pollInterval);
    for (let i = 0; i < tries; i++) {
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        await tcpPort.fetch(`http://${this.pingEndpoint}`, { signal: combinedSignal });
        break;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if (!this.container.running) {
          try {
            await this.onError(new Error(`Container crashed while checking for ports, did you start the container and setup the entrypoint correctly?`));
          } catch {
          }
          throw e;
        }
        if (i === tries - 1) {
          try {
            await this.onError(`Failed to verify port ${port} is available after ${(i + 1) * pollInterval}ms, last error: ${errorMessage}`);
          } catch {
          }
          throw e;
        }
        await Promise.any([
          new Promise((resolve) => setTimeout(resolve, pollInterval)),
          abortedSignal
        ]);
        if (waitOptions.signal?.aborted) {
          throw new Error("Container request aborted.", { cause: e });
        }
      }
    }
    return tries;
  }
  // =======================
  //     LIFECYCLE HOOKS
  // =======================
  /**
   * Send a signal to the container.
   * @param signal - The signal to send to the container (default: 15 for SIGTERM)
   */
  async stop(signal = "SIGTERM") {
    if (this.container.running) {
      this.container.signal(typeof signal === "string" ? signalToNumbers[signal] : signal);
    }
    await this.syncPendingStoppedEvents();
  }
  /**
   * Destroys the container with a SIGKILL. Triggers onStop.
   */
  async destroy() {
    await this.container.destroy();
  }
  /**
   * Lifecycle method called when container starts successfully
   * Override this method in subclasses to handle container start events
   */
  onStart() {
  }
  /**
   * Lifecycle method called when container shuts down
   * Override this method in subclasses to handle Container stopped events
   * @param params - Object containing exitCode and reason for the stop
   */
  onStop(params) {
    void params;
  }
  /**
   * Lifecycle method called when the container is running, and the activity timeout
   * expiration (set by `sleepAfter`) has been reached.
   *
   * If you want to shutdown the container, you should call this.stop() here
   *
   * By default, this method calls `this.stop()`
   */
  async onActivityExpired() {
    console.log("Activity expired, signalling container to stop");
    if (!this.container.running) {
      return;
    }
    await this.stop();
  }
  /**
   * Error handler for container errors
   * Override this method in subclasses to handle container errors
   * @param error - The error that occurred
   * @returns Can return any value or throw the error
   */
  onError(error) {
    console.error("Container error:", error);
    throw error;
  }
  /**
   * Renew the container's activity timeout
   *
   * Call this method whenever there is activity on the container
   */
  renewActivityTimeout() {
    const timeoutInMs = parseTimeExpression(this.sleepAfter) * 1e3;
    this.sleepAfterMs = Date.now() + timeoutInMs;
  }
  /**
   * Decrement the inflight request counter.
   * When the counter transitions to 0, renew the activity timeout so the
   * inactivity window starts fresh from the moment the last request completes.
   */
  decrementInflight() {
    this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    if (this.inflightRequests === 0) {
      this.renewActivityTimeout();
    }
  }
  // ==================
  //     SCHEDULING
  // ==================
  /**
   * Schedule a task to be executed in the future.
   *
   * We strongly recommend using this instead of the `alarm` handler.
   *
   * @template T Type of the payload data
   * @param when When to execute the task (Date object or number of seconds delay)
   * @param callback Name of the method to call
   * @param payload Data to pass to the callback
   * @returns Schedule object representing the scheduled task
   */
  async schedule(when, callback, payload) {
    const id = generateId(9);
    if (typeof callback !== "string") {
      throw new Error("Callback must be a string (method name)");
    }
    if (typeof this[callback] !== "function") {
      throw new Error(`this.${callback} is not a function`);
    }
    if (when instanceof Date) {
      const timestamp = Math.floor(when.getTime() / 1e3);
      this.sql`
        INSERT OR REPLACE INTO container_schedules (id, callback, payload, type, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'scheduled', ${timestamp})
      `;
      await this.scheduleNextAlarm();
      return {
        taskId: id,
        callback,
        payload,
        time: timestamp,
        type: "scheduled"
      };
    }
    if (typeof when === "number") {
      const time = Math.floor(Date.now() / 1e3 + when);
      this.sql`
        INSERT OR REPLACE INTO container_schedules (id, callback, payload, type, delayInSeconds, time)
        VALUES (${id}, ${callback}, ${JSON.stringify(payload)}, 'delayed', ${when}, ${time})
      `;
      await this.scheduleNextAlarm();
      return {
        taskId: id,
        callback,
        payload,
        delayInSeconds: when,
        time,
        type: "delayed"
      };
    }
    throw new Error("Invalid schedule type. 'when' must be a Date or number of seconds");
  }
  // ============
  //     HTTP
  // ============
  /**
   * Send a request to the container (HTTP or WebSocket) using standard fetch API signature
   *
   * This method handles HTTP requests to the container.
   *
   * WebSocket requests done outside the DO won't work until https://github.com/cloudflare/workerd/issues/2319 is addressed.
   * Until then, please use `switchPort` + `fetch()`.
   *
   * Method supports multiple signatures to match standard fetch API:
   * - containerFetch(request: Request, port?: number)
   * - containerFetch(url: string | URL, init?: RequestInit, port?: number)
   *
   * Starts the container if not already running, and waits for the target port to be ready.
   *
   * @returns A Response from the container
   */
  async containerFetch(requestOrUrl, portOrInit, portParam) {
    const { request, port } = this.requestAndPortFromContainerFetchArgs(requestOrUrl, portOrInit, portParam);
    const state = await this.state.getState();
    if (!this.container.running || state.status !== "healthy") {
      try {
        await this.startAndWaitForPorts(port, { abort: request.signal });
      } catch (e) {
        if (isNoInstanceError(e)) {
          return new Response("There is no Container instance available at this time.\nThis is likely because you have reached your max concurrent instance count (set in wrangler config) or are you currently provisioning the Container.\nIf you are deploying your Container for the first time, check your dashboard to see provisioning status, this may take a few minutes.", { status: 503 });
        }
        if (isRateLimitedError(e)) {
          return new Response(e instanceof Error ? e.message : String(e), { status: 429 });
        }
        return new Response(`Failed to start container: ${e instanceof Error ? e.message : String(e)}`, {
          status: 500
        });
      }
    }
    const tcpPort = this.container.getTcpPort(port);
    const containerUrl = request.url.replace("https:", "http:");
    this.inflightRequests++;
    try {
      this.renewActivityTimeout();
      const res = await tcpPort.fetch(containerUrl, request);
      if (res.webSocket !== null) {
        const containerWs = res.webSocket;
        const [client, server] = Object.values(new WebSocketPair());
        let settled = false;
        const settleInflight = /* @__PURE__ */ __name(() => {
          if (!settled) {
            settled = true;
            this.decrementInflight();
          }
        }, "settleInflight");
        containerWs.accept();
        server.accept();
        server.addEventListener("message", async (event) => {
          this.renewActivityTimeout();
          try {
            const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            containerWs.send(data);
          } catch {
            server.close(1011, "Failed to forward message to container");
          }
        });
        containerWs.addEventListener("message", async (event) => {
          this.renewActivityTimeout();
          try {
            const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
            server.send(data);
          } catch {
            containerWs.close(1011, "Failed to forward message to client");
          }
        });
        server.addEventListener("close", (event) => {
          settleInflight();
          const code = event.code === 1005 || event.code === 1006 ? 1e3 : event.code;
          containerWs.close(code, event.reason);
        });
        containerWs.addEventListener("close", (event) => {
          settleInflight();
          const code = event.code === 1005 || event.code === 1006 ? 1e3 : event.code;
          server.close(code, event.reason);
        });
        server.addEventListener("error", () => {
          settleInflight();
          containerWs.close(1011, "Client WebSocket error");
        });
        containerWs.addEventListener("error", () => {
          settleInflight();
          server.close(1011, "Container WebSocket error");
        });
        return new Response(null, { status: res.status, webSocket: client, headers: res.headers });
      }
      if (res.body !== null) {
        const { readable, writable } = new IdentityTransformStream();
        res.body?.pipeTo(writable).finally(() => {
          this.decrementInflight();
        });
        return new Response(readable, res);
      }
      this.decrementInflight();
      return res;
    } catch (e) {
      this.decrementInflight();
      if (!(e instanceof Error)) {
        throw e;
      }
      if (e.message.includes("Network connection lost.")) {
        return new Response("Container suddenly disconnected, try again", { status: 500 });
      }
      console.error(`Error proxying request to container ${this.ctx.id}:`, e);
      return new Response(`Error proxying request to container: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
    }
  }
  /**
   *
   * Fetch handler on the Container class.
   * By default this forwards all requests to the container by calling `containerFetch`.
   * Use `switchPort` to specify which port on the container to target, or this will use `defaultPort`.
   * @param request The request to handle
   */
  async fetch(request) {
    if (this.defaultPort === void 0 && !request.headers.has("cf-container-target-port")) {
      throw new Error("No port configured for this container. Set the `defaultPort` in your Container subclass, or specify a port with `container.fetch(switchPort(request, port))`.");
    }
    let portValue = this.defaultPort;
    if (request.headers.has("cf-container-target-port")) {
      const portFromHeaders = parseInt(request.headers.get("cf-container-target-port") ?? "");
      if (isNaN(portFromHeaders)) {
        throw new Error("port value from switchPort is not a number");
      } else {
        portValue = portFromHeaders;
      }
    }
    return await this.containerFetch(request, portValue);
  }
  // ===============================
  // ===============================
  //     PRIVATE METHODS & ATTRS
  // ===============================
  // ===============================
  // ==========================
  //     PRIVATE ATTRIBUTES
  // ==========================
  container;
  // onStopCalled will be true when we are in the middle of an onStop call
  onStopCalled = false;
  state;
  monitor;
  // Coalesces concurrent calls to startContainerIfNotRunning so we never
  // call `this.container.start()` twice. Without this guard, two requests
  // racing the readiness path can both pass the `if (this.container.running)`
  // early-return (each yielding the DO input gate at storage awaits) and
  // both reach the synchronous workerd `start()`, causing the second to
  // throw "start() cannot be called on a container that is already running."
  // See https://github.com/cloudflare/containers/issues/173.
  startInFlight;
  monitoredPromise;
  sleepAfterMs = 0;
  inflightRequests = 0;
  // Outbound interception runtime overrides (passed through ContainerProxy props)
  outboundByHostOverrides = {};
  outboundHandlerOverride;
  // Only set when the user calls setAllowedHosts/setDeniedHosts at runtime
  allowedHostsOverride;
  deniedHostsOverride;
  // The runtime does not expose a way to remove outbound interceptions yet, so
  // once we promote an instance to intercept-all we must keep using it.
  hasInterceptAllRegistration = false;
  // ==========================
  //     GENERAL HELPERS
  // ==========================
  /**
   * Validates that a method name exists in the outboundHandlers registry for this class.
   * @throws Error if the method name is not found
   */
  validateOutboundHandlerMethodName(methodName) {
    const handlers = outboundHandlersRegistry.get(this.constructor.name);
    if (!handlers || !(methodName in handlers)) {
      throw new Error(`Outbound handler method '${methodName}' not found in outboundHandlers for ${this.constructor.name}`);
    }
  }
  get effectiveAllowedHosts() {
    return this.allowedHostsOverride ?? this.allowedHosts;
  }
  get effectiveDeniedHosts() {
    return this.deniedHostsOverride ?? this.deniedHosts;
  }
  getOutboundConfiguration() {
    return {
      outboundByHostOverrides: Object.keys(this.outboundByHostOverrides).length > 0 ? this.outboundByHostOverrides : void 0,
      outboundHandlerOverride: this.outboundHandlerOverride,
      allowedHosts: this.effectiveAllowedHosts,
      deniedHosts: this.effectiveDeniedHosts,
      hasInterceptAllRegistration: this.hasInterceptAllRegistration || void 0
    };
  }
  persistOutboundConfiguration(configuration) {
    this.ctx.storage.kv.put(OUTBOUND_CONFIGURATION_KEY, {
      ...configuration,
      allowedHosts: this.allowedHostsOverride,
      deniedHosts: this.deniedHostsOverride
    });
  }
  restoreOutboundConfiguration() {
    const configuration = this.ctx.storage.kv.get(OUTBOUND_CONFIGURATION_KEY);
    if (!configuration) {
      return void 0;
    }
    this.outboundHandlerOverride = void 0;
    if (configuration.outboundHandlerOverride !== void 0) {
      try {
        this.validateOutboundHandlerMethodName(configuration.outboundHandlerOverride.method);
        this.outboundHandlerOverride = configuration.outboundHandlerOverride;
      } catch (error) {
        console.warn("Ignoring invalid persisted outbound handler override:", error);
      }
    }
    this.outboundByHostOverrides = {};
    for (const [hostname, override] of Object.entries(configuration.outboundByHostOverrides ?? {})) {
      try {
        this.validateOutboundHandlerMethodName(override.method);
        this.outboundByHostOverrides[hostname] = override;
      } catch (error) {
        console.warn(`Ignoring invalid persisted outbound override for ${hostname}:`, error);
      }
    }
    this.hasInterceptAllRegistration = configuration.hasInterceptAllRegistration === true;
    if (configuration.allowedHosts) {
      this.allowedHostsOverride = configuration.allowedHosts;
    }
    if (configuration.deniedHosts) {
      this.deniedHostsOverride = configuration.deniedHosts;
    }
    return this.getOutboundConfiguration();
  }
  /**
   * Returns true if a catch-all outbound HTTP interception is needed.
   * This is the case when a static `outbound` handler or a runtime
   * `outboundHandlerOverride` (catch-all) is configured.
   * When false, we only intercept specific hosts to avoid overhead.
   */
  needsCatchAllInterception() {
    const ctor = this.constructor;
    return ctor.outbound !== void 0 || this.outboundHandlerOverride !== void 0;
  }
  hasMutableOutboundConfiguration() {
    return Object.keys(this.outboundByHostOverrides).length > 0 || this.allowedHostsOverride !== void 0 || this.deniedHostsOverride !== void 0;
  }
  shouldInterceptAllOutbound() {
    return this.hasInterceptAllRegistration || this.needsCatchAllInterception() || this.effectiveAllowedHosts !== void 0 || this.effectiveDeniedHosts !== void 0 || this.hasMutableOutboundConfiguration();
  }
  getStaticOutboundByHostKeys() {
    const ctor = this.constructor;
    return ctor.outboundByHost ? Object.keys(ctor.outboundByHost) : [];
  }
  /**
   * Collects all hostnames that need per-host outbound interception.
   * This path is only used for the narrow optimized case where outbound
   * handling is static and host-specific.
   */
  getHostsToIntercept() {
    const hosts = /* @__PURE__ */ new Set();
    const ctor = this.constructor;
    if (ctor.outboundByHost) {
      for (const hostname of Object.keys(ctor.outboundByHost)) {
        hosts.add(hostname);
      }
    }
    for (const hostname of Object.keys(this.outboundByHostOverrides)) {
      hosts.add(hostname);
    }
    return [...hosts];
  }
  async refreshOutboundInterception() {
    if (!this.usingInterception) {
      return;
    }
    this.applyOutboundInterceptionPromise = this.applyOutboundInterception();
    await this.applyOutboundInterceptionPromise;
  }
  /**
   * Applies (or re-applies) outbound HTTP interception with the current
   * default registries + runtime overrides passed through ContainerProxy props.
   *
   * Uses per-host interception only for static host-specific outbound handlers.
   * As soon as the config needs to evaluate all hosts (catch-all outbound,
   * allow/deny lists, or runtime-mutated outbound config), we promote the
   * container to intercept-all and keep it there until the instance restarts.
   *
   * When `interceptHttps` is enabled, also applies HTTPS interception:
   * - Intercept-all mode: `interceptOutboundHttps('*', ...)` for all HTTPS traffic
   * - Per-host mode: `interceptOutboundHttps(host, ...)` for each known host
   */
  async applyOutboundInterception() {
    const ctx = this.ctx;
    if (ctx.exports === void 0) {
      throw new Error("ctx.exports is undefined, please try to update your compatibility date or export ContainerProxy from the containers package in your worker entrypoint");
    }
    if (ctx.exports.ContainerProxy === void 0) {
      throw new Error("ctx.exports.ContainerProxy is undefined, export ContainerProxy from the containers package in your worker entrypoint");
    }
    const interceptAll = this.shouldInterceptAllOutbound();
    if (interceptAll) {
      this.hasInterceptAllRegistration = interceptAll;
    }
    const outboundConfiguration = this.getOutboundConfiguration();
    this.persistOutboundConfiguration(outboundConfiguration);
    const hosts = this.getHostsToIntercept();
    const props = {
      enableInternet: this.enableInternet,
      containerId: this.ctx.id.toString(),
      className: this.constructor.name,
      outboundByHostOverrides: outboundConfiguration.outboundByHostOverrides,
      outboundHandlerOverride: outboundConfiguration.outboundHandlerOverride,
      allowedHosts: outboundConfiguration.allowedHosts,
      deniedHosts: outboundConfiguration.deniedHosts,
      interceptAll
    };
    const fetcher = ctx.exports.ContainerProxy({
      props
    });
    if (interceptAll) {
      for (const host of this.getStaticOutboundByHostKeys()) {
        await this.container.interceptOutboundHttp(host, fetcher);
        if (this.interceptHttps) {
          await this.container.interceptOutboundHttps(host, fetcher);
        }
      }
      if (this.interceptHttps) {
        await this.container.interceptOutboundHttps("*", fetcher);
      }
      await this.container.interceptAllOutboundHttp(fetcher);
    } else {
      for (const host of hosts) {
        await this.container.interceptOutboundHttp(host, fetcher);
        if (this.interceptHttps) {
          await this.container.interceptOutboundHttps(host, fetcher);
        }
      }
    }
  }
  /**
   * Execute SQL queries against the Container's database
   */
  sql(strings, ...values) {
    const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? "?" : ""), "");
    return [...this.ctx.storage.sql.exec(query, ...values)];
  }
  requestAndPortFromContainerFetchArgs(requestOrUrl, portOrInit, portParam) {
    let request;
    let port;
    if (requestOrUrl instanceof Request) {
      request = requestOrUrl;
      port = typeof portOrInit === "number" ? portOrInit : void 0;
    } else {
      const url = typeof requestOrUrl === "string" ? requestOrUrl : requestOrUrl.toString();
      const init = typeof portOrInit === "number" ? {} : portOrInit || {};
      port = typeof portOrInit === "number" ? portOrInit : typeof portParam === "number" ? portParam : void 0;
      request = new Request(url, init);
    }
    port ??= this.defaultPort;
    if (port === void 0) {
      throw new Error("No port specified for container fetch. Set defaultPort or specify a port parameter.");
    }
    return { request, port };
  }
  /**
   *
   * The method prioritizes port sources in this order:
   * 1. Ports specified directly in the method call
   * 2. `requiredPorts` class property (if set)
   * 3. `defaultPort` (if neither of the above is specified)
   * 4. Falls back to port 33 if none of the above are set
   */
  async getPortsToCheck(overridePorts) {
    if (overridePorts !== void 0) {
      return Array.isArray(overridePorts) ? overridePorts : [overridePorts];
    }
    if (this.requiredPorts && this.requiredPorts.length > 0) {
      return [...this.requiredPorts];
    }
    return [this.defaultPort ?? FALLBACK_PORT_TO_CHECK];
  }
  // ===========================================
  //     CONTAINER INTERACTION & MONITORING
  // ===========================================
  /**
   * Tries to start a container if it's not already running
   * Returns the number of tries used
   */
  async startContainerIfNotRunning(waitOptions, options) {
    if (this.startInFlight) {
      return this.startInFlight;
    }
    if (this.container.running) {
      if (!this.monitor) {
        this.monitor = this.container.monitor();
      }
      return 0;
    }
    const startPromise = this.doStartContainer(waitOptions, options);
    this.startInFlight = startPromise;
    try {
      return await startPromise;
    } finally {
      if (this.startInFlight === startPromise) {
        this.startInFlight = void 0;
      }
    }
  }
  async doStartContainer(waitOptions, options) {
    const abortedSignal = new Promise((res) => {
      waitOptions.signal?.addEventListener("abort", () => {
        res(true);
      });
    });
    const pollInterval = waitOptions.waitInterval ?? INSTANCE_POLL_INTERVAL_MS;
    const totalTries = waitOptions.retries ?? Math.ceil(TIMEOUT_TO_GET_CONTAINER_MS / pollInterval);
    for (let tries = 0; tries < totalTries; tries++) {
      const envVars = options?.envVars ?? this.envVars;
      const entrypoint = options?.entrypoint ?? this.entrypoint;
      const enableInternet = options?.enableInternet ?? this.enableInternet;
      const labels = options?.labels ?? this.labels;
      const startConfig = {
        enableInternet
      };
      if (envVars && Object.keys(envVars).length > 0)
        startConfig.env = envVars;
      if (entrypoint)
        startConfig.entrypoint = entrypoint;
      if (labels && Object.keys(labels).length > 0)
        startConfig.labels = labels;
      this.renewActivityTimeout();
      const handleError = /* @__PURE__ */ __name(async () => {
        const err = await this.monitor?.catch((err2) => err2);
        if (typeof err === "number") {
          const toThrow = new Error(`Container exited before we could determine the container health, exit code: ${err}`);
          await this.state.setStoppedWithCode(err);
          this.monitor = void 0;
          try {
            await this.onError(toThrow);
          } catch {
          }
          throw toThrow;
        } else if (!isNoInstanceError(err)) {
          await this.state.setStopped();
          this.monitor = void 0;
          try {
            await this.onError(err);
          } catch {
          }
          throw err;
        }
      }, "handleError");
      if (tries > 0 && !this.container.running) {
        await handleError();
      }
      await this.scheduleNextAlarm();
      if (!this.container.running) {
        await this.refreshOutboundInterception();
        this.container.start(startConfig);
        this.monitor = this.container.monitor();
        await this.state.setRunning();
      } else {
        await this.scheduleNextAlarm();
      }
      this.renewActivityTimeout();
      const port = this.container.getTcpPort(waitOptions.portToCheck);
      try {
        const combinedSignal = addTimeoutSignal(waitOptions.signal, PING_TIMEOUT_MS);
        await port.fetch("http://containerstarthealthcheck", { signal: combinedSignal });
        return tries;
      } catch (error) {
        if (isNotListeningError(error) && this.container.running) {
          return tries;
        }
        if (!this.container.running && isNotListeningError(error)) {
          await handleError();
        }
        await Promise.any([
          new Promise((res) => setTimeout(res, waitOptions.waitInterval)),
          abortedSignal
        ]);
        if (waitOptions.signal?.aborted) {
          throw new Error("Aborted waiting for container to start as we received a cancellation signal", { cause: error });
        }
        if (totalTries === tries + 1) {
          if (error instanceof Error && error.message.includes("Network connection lost")) {
            this.ctx.abort();
          }
          await handleError();
          await this.state.setStopped();
          this.monitor = void 0;
          throw new Error(NO_CONTAINER_INSTANCE_ERROR, { cause: error });
        }
        continue;
      }
    }
    throw new Error(`Container did not start after ${totalTries * pollInterval}ms`);
  }
  setupMonitorCallbacks() {
    const monitor = this.monitor;
    if (!monitor || this.monitoredPromise === monitor) {
      return;
    }
    this.monitoredPromise = monitor;
    monitor.then(async () => {
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.monitor === monitor) {
          await this.state.setStoppedWithCode(0);
        }
      });
    }).catch(async (error) => {
      if (this.monitor !== monitor) {
        return;
      }
      if (isNoInstanceError(error)) {
        await this.ctx.blockConcurrencyWhile(async () => {
          if (this.monitor === monitor) {
            await this.state.setStopped();
          }
        });
        return;
      }
      const exitCode = getExitCodeFromError(error);
      if (exitCode !== null) {
        await this.ctx.blockConcurrencyWhile(async () => {
          if (this.monitor === monitor) {
            await this.state.setStoppedWithCode(exitCode);
          }
        });
        return;
      }
      await this.ctx.blockConcurrencyWhile(async () => {
        if (this.monitor === monitor) {
          await this.state.setStopped();
        }
      });
      if (this.monitor !== monitor) {
        return;
      }
      try {
        await this.onError(error);
      } catch {
      }
    }).finally(() => {
      if (this.monitor !== monitor) {
        return;
      }
      this.monitoredPromise = void 0;
      this.monitor = void 0;
      if (this.timeout) {
        if (this.resolve)
          this.resolve();
        clearTimeout(this.timeout);
      }
    });
  }
  deleteSchedules(name) {
    this.sql`DELETE FROM container_schedules WHERE callback = ${name}`;
  }
  // ============================
  //     ALARMS AND SCHEDULES
  // ============================
  /**
   * Method called when an alarm fires
   * Executes any scheduled tasks that are due
   */
  async alarm(alarmProps) {
    if (alarmProps !== void 0 && alarmProps.isRetry && alarmProps.retryCount > MAX_ALARM_RETRIES) {
      const scheduleCount = Number(this.sql`SELECT COUNT(*) as count FROM container_schedules`[0]?.count) || 0;
      const hasScheduledTasks = scheduleCount > 0;
      if (hasScheduledTasks || this.container.running) {
        await this.scheduleNextAlarm();
      }
      return;
    }
    const prevAlarm = Date.now();
    await this.ctx.storage.setAlarm(prevAlarm);
    await this.ctx.storage.sync();
    const result = this.sql`
         SELECT * FROM container_schedules;
       `;
    let minTime = Date.now() + 3 * 60 * 1e3;
    const now = Date.now() / 1e3;
    for (const row of result) {
      if (row.time > now) {
        continue;
      }
      const callback = this[row.callback];
      if (!callback || typeof callback !== "function") {
        console.error(`Callback ${row.callback} not found or is not a function`);
        continue;
      }
      const schedule = this.getSchedule(row.id);
      try {
        const payload = row.payload ? JSON.parse(row.payload) : void 0;
        await callback.call(this, payload, await schedule);
      } catch (e) {
        console.error(`Error executing scheduled callback "${row.callback}":`, e);
      }
      this.sql`DELETE FROM container_schedules WHERE id = ${row.id}`;
    }
    const resultForMinTime = this.sql`
         SELECT * FROM container_schedules;
       `;
    const minTimeFromSchedules = Math.min(...resultForMinTime.map((r) => r.time * 1e3));
    if (!this.container.running) {
      await this.syncPendingStoppedEvents();
      if (resultForMinTime.length == 0) {
        await this.ctx.storage.deleteAlarm();
      } else {
        await this.ctx.storage.setAlarm(minTimeFromSchedules);
      }
      return;
    }
    if (this.isActivityExpired()) {
      await this.onActivityExpired();
      this.renewActivityTimeout();
      return;
    }
    minTime = Math.min(minTimeFromSchedules, minTime, this.sleepAfterMs);
    const timeout = Math.max(0, minTime - Date.now());
    await new Promise((resolve) => {
      this.resolve = resolve;
      if (!this.container.running) {
        resolve();
        return;
      }
      this.timeout = setTimeout(() => {
        resolve();
      }, timeout);
    });
    await this.ctx.storage.setAlarm(Date.now());
  }
  timeout;
  resolve;
  // synchronises container state with the container source of truth to process events
  async syncPendingStoppedEvents() {
    const state = await this.state.getState();
    if (!this.container.running && (state.status === "healthy" || state.status === "running")) {
      await this.callOnStop({ exitCode: 0, reason: "exit" }, state);
      return;
    }
    if (!this.container.running && state.status === "stopped_with_code") {
      await this.callOnStop({ exitCode: state.exitCode ?? 0, reason: "exit" }, state);
      return;
    }
  }
  async callOnStop(onStopParams, stateBeforeOnStop) {
    if (this.onStopCalled) {
      return;
    }
    this.onStopCalled = true;
    const promise = this.onStop(onStopParams);
    if (promise instanceof Promise) {
      await promise.finally(() => {
        this.onStopCalled = false;
      });
    } else {
      this.onStopCalled = false;
    }
    await this.state.setStoppedIfUnchanged(stateBeforeOnStop);
  }
  /**
   * Schedule the next alarm based on upcoming tasks
   */
  async scheduleNextAlarm(ms = 1e3) {
    const nextTime = ms + Date.now();
    if (this.timeout) {
      if (this.resolve)
        this.resolve();
      clearTimeout(this.timeout);
    }
    await this.ctx.storage.setAlarm(nextTime);
    await this.ctx.storage.sync();
  }
  async listSchedules(name) {
    const result = this.sql`
      SELECT * FROM container_schedules WHERE callback = ${name} LIMIT 1
    `;
    if (!result || result.length === 0) {
      return [];
    }
    return result.map(this.toSchedule);
  }
  toSchedule(schedule) {
    let payload;
    try {
      payload = JSON.parse(schedule.payload);
    } catch (e) {
      console.error(`Error parsing payload for schedule ${schedule.id}:`, e);
      payload = void 0;
    }
    if (schedule.type === "delayed") {
      return {
        taskId: schedule.id,
        callback: schedule.callback,
        payload,
        type: "delayed",
        time: schedule.time,
        delayInSeconds: schedule.delayInSeconds
      };
    }
    return {
      taskId: schedule.id,
      callback: schedule.callback,
      payload,
      type: "scheduled",
      time: schedule.time
    };
  }
  /**
   * Get a scheduled task by ID
   * @template T Type of the payload data
   * @param id ID of the scheduled task
   * @returns The Schedule object or undefined if not found
   */
  async getSchedule(id) {
    const result = this.sql`
      SELECT * FROM container_schedules WHERE id = ${id} LIMIT 1
    `;
    if (!result || result.length === 0) {
      return void 0;
    }
    const schedule = result[0];
    return this.toSchedule(schedule);
  }
  isActivityExpired() {
    if (this.inflightRequests > 0) {
      this.renewActivityTimeout();
      return false;
    }
    return this.sleepAfterMs <= Date.now();
  }
};

// src/dashboard.ts
var CONTROLLER_ORIGIN = "https://wolfstar-github-agent.localhost";
async function proxyDashboard(request, controller2) {
  const url = new URL(request.url);
  const origin = request.headers.get("origin");
  if (request.method !== "GET" && request.method !== "HEAD" && origin !== url.origin)
    return new Response("Request origin is not allowed.", { status: 403 });
  const target = new URL(url.pathname + url.search, CONTROLLER_ORIGIN.replace("https:", "http:"));
  const headers = new Headers(request.headers);
  if (origin === url.origin) headers.set("origin", CONTROLLER_ORIGIN);
  return controller2.proxyDashboard(
    new Request(target, {
      method: request.method,
      headers,
      // Dashboard writes are small JSON bodies. Buffering them keeps the request replayable over RPC.
      body: request.method === "GET" || request.method === "HEAD" ? null : await request.arrayBuffer(),
      redirect: "manual"
    })
  );
}
__name(proxyDashboard, "proxyDashboard");

// src/setup.ts
var EMPTY_SETUP = {
  app: null,
  dashboardPassword: null,
  sessionHash: null,
  manifestState: null,
  providers: { claudeToken: null, codexAuth: null, zaiApiKey: null },
  mutationsEnabled: true,
  issueCutoff: null
};
function isReady(record) {
  const { claudeToken, codexAuth, zaiApiKey } = record.providers;
  return record.app !== null && record.dashboardPassword !== null && (claudeToken ?? codexAuth ?? zaiApiKey) !== null;
}
__name(isReady, "isReady");
var DASHBOARD_USER = "agent";
var SESSION_COOKIE = "wolfstar_setup";
var STATE_COOKIE = "wolfstar_setup_state";
var MANIFEST_STATE_SECONDS = 60 * 60;
var GITHUB_API = "https://api.github.com";
var USER_AGENT = "wolfstar-github-edge";
function appManifest(origin, owner, suffix) {
  return {
    // App names are global on GitHub and capped at 34 characters.
    name: `${owner.slice(0, 22)}-agent-${suffix}`,
    url: origin,
    hook_attributes: { url: `${origin}/webhook`, active: true },
    redirect_url: `${origin}/setup/callback`,
    setup_url: `${origin}/setup/installed`,
    setup_on_update: true,
    public: false,
    default_permissions: {
      actions: "write",
      administration: "read",
      checks: "write",
      contents: "write",
      deployments: "write",
      issues: "write",
      metadata: "read",
      pull_requests: "write",
      statuses: "read"
    },
    default_events: [
      "check_run",
      "check_suite",
      "issue_comment",
      "issues",
      "pull_request",
      "pull_request_review",
      "push",
      "status"
    ]
  };
}
__name(appManifest, "appManifest");
function randomToken(bytes = 32) {
  const values = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...values)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
__name(randomToken, "randomToken");
async function sha256(value) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
__name(sha256, "sha256");
async function sameSecret(left, right) {
  const [a, b] = await Promise.all([sha256(left), sha256(right)]);
  let difference = 0;
  for (let index = 0; index < a.length; index++) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}
__name(sameSecret, "sameSecret");
function cookie(request, name) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}
__name(cookie, "cookie");
function setCookie(name, value, maxAge) {
  return `${name}=${value}; Path=/setup; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
__name(setCookie, "setCookie");
async function hasDashboardPassword(request, record) {
  const header = request.headers.get("authorization");
  if (record.dashboardPassword === null || header === null || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = atob(header.slice("Basic ".length));
  } catch {
    return false;
  }
  const separator = decoded.indexOf(":");
  if (separator === -1 || decoded.slice(0, separator) !== DASHBOARD_USER) return false;
  return sameSecret(decoded.slice(separator + 1), record.dashboardPassword);
}
__name(hasDashboardPassword, "hasDashboardPassword");
async function hasSession(request, record) {
  const value = cookie(request, SESSION_COOKIE);
  return value !== null && record.sessionHash !== null && await sameSecret(await sha256(value), record.sessionHash);
}
__name(hasSession, "hasSession");
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
__name(escapeHtml, "escapeHtml");
function page(title, body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action https://github.com 'self'"
  );
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:42rem;margin:3rem auto;padding:0 1rem;color:#1f2328}code,textarea,input{font:14px ui-monospace,monospace}textarea,input[type=password],input[type=text]{width:100%;box-sizing:border-box;padding:.4rem}label{display:block;margin-top:1rem;font-weight:600}small{color:#59636e;font-weight:400}button{margin-top:1.5rem;padding:.5rem 1rem;font-size:1rem}.box{background:#f6f8fa;padding:1rem;border-radius:6px;word-break:break-all}</style></head><body>${body}</body></html>`,
    { ...init, headers }
  );
}
__name(page, "page");
function redirect(location, headers = {}) {
  const response = new Response(null, { status: 303, headers });
  response.headers.set("location", location);
  return response;
}
__name(redirect, "redirect");
function unauthorized() {
  return new Response("Sign in with the dashboard password.", {
    status: 401,
    headers: { "www-authenticate": 'Basic realm="Wolfstar GitHub Agent", charset="UTF-8"' }
  });
}
__name(unauthorized, "unauthorized");
function primaryOwner(allowedOwners) {
  return allowedOwners[0]?.split("/")[0] ?? null;
}
__name(primaryOwner, "primaryOwner");
async function githubJson(dependencies2, path, init = {}) {
  const response = await dependencies2.fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT, ...init.headers }
  });
  if (!response.ok) throw new Error(`GitHub answered ${response.status} for ${path}.`);
  return response.json();
}
__name(githubJson, "githubJson");
async function startSetup(request, dependencies2, record) {
  const owner = primaryOwner(dependencies2.allowedOwners);
  if (owner === null) return page("Setup", "<h1>Setup</h1><p>Set <code>ALLOWED_OWNERS</code> in wrangler.jsonc.</p>");
  const account = await githubJson(dependencies2, `/users/${encodeURIComponent(owner)}`);
  const origin = new URL(request.url).origin;
  const state = randomToken();
  await dependencies2.store.write({
    ...record,
    manifestState: { hash: await sha256(state), expiresAt: dependencies2.now() + MANIFEST_STATE_SECONDS * 1e3 }
  });
  const action = account.type === "Organization" ? `https://github.com/organizations/${encodeURIComponent(owner)}/settings/apps/new` : "https://github.com/settings/apps/new";
  const manifest = JSON.stringify(
    appManifest(
      origin,
      owner,
      randomToken(3).toLowerCase().replace(/[^a-z0-9]/g, "x")
    )
  );
  return page(
    "Set up the Wolfstar GitHub Agent",
    `<h1>Set up the Wolfstar GitHub Agent</h1>
<p>This creates a private GitHub App owned by <code>${escapeHtml(owner)}</code>, with the permissions and webhook the agent needs. GitHub asks you to confirm the name.</p>
<form method="post" action="${escapeHtml(action)}?state=${encodeURIComponent(state)}">
<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">
<button type="submit">Create the GitHub App</button>
</form>`,
    { headers: { "set-cookie": setCookie(STATE_COOKIE, state, MANIFEST_STATE_SECONDS) } }
  );
}
__name(startSetup, "startSetup");
async function finishManifest(request, dependencies2, record) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const browserState = cookie(request, STATE_COOKIE);
  if (code === null || !/^[\w-]{1,128}$/.test(code) || state === null || browserState === null || record.manifestState === null || record.manifestState.expiresAt < dependencies2.now() || !await sameSecret(state, browserState) || !await sameSecret(await sha256(state), record.manifestState.hash))
    return page("Setup expired", '<h1>Setup expired</h1><p><a href="/setup">Start again</a>.</p>', { status: 400 });
  const app = await githubJson(dependencies2, `/app-manifests/${code}/conversions`, {
    method: "POST"
  });
  const owner = app.owner.login;
  if (!dependencies2.allowedOwners.some((allowed) => allowed.split("/")[0].toLowerCase() === owner.toLowerCase()))
    return page(
      "Owner not allowed",
      `<h1>Owner not allowed</h1><p>The App belongs to <code>${escapeHtml(owner)}</code>, which <code>ALLOWED_OWNERS</code> does not list. Delete it on GitHub and start again.</p>`,
      { status: 403 }
    );
  if (app.webhook_secret === null)
    return page(
      "No webhook secret",
      "<h1>No webhook secret</h1><p>GitHub created the App without one. Delete it and start again.</p>",
      {
        status: 502
      }
    );
  const botLogin = `${app.slug}[bot]`;
  const bot = await githubJson(dependencies2, `/users/${encodeURIComponent(botLogin)}`).catch(() => null);
  const session = randomToken();
  const today = new Date(dependencies2.now());
  const cutoff = new Date(today.getTime() - 30 * 24 * 60 * 60 * 1e3).toISOString().slice(0, 10);
  await dependencies2.store.write({
    ...record,
    app: {
      id: app.id,
      slug: app.slug,
      owner,
      htmlUrl: app.html_url,
      privateKey: app.pem,
      webhookSecret: app.webhook_secret,
      gitName: botLogin,
      gitEmail: bot?.id === void 0 ? `${botLogin}@users.noreply.github.com` : `${bot.id}+${botLogin}@users.noreply.github.com`
    },
    dashboardPassword: randomToken(),
    sessionHash: await sha256(session),
    manifestState: null,
    issueCutoff: cutoff
  });
  const headers = new Headers({ location: "/setup/providers" });
  headers.append("set-cookie", setCookie(SESSION_COOKIE, session, 24 * 60 * 60));
  headers.append("set-cookie", setCookie(STATE_COOKIE, "", 0));
  return new Response(null, { status: 303, headers });
}
__name(finishManifest, "finishManifest");
function providersPage(record, origin, saved) {
  const app = record.app;
  const set = /* @__PURE__ */ __name((value) => value === null ? "" : " <small>(saved, leave empty to keep)</small>", "set");
  return page(
    "Agent providers",
    `<h1>Agent providers</h1>
${saved ? "<p><strong>Saved.</strong> The controller is restarting with these settings.</p>" : ""}
<p>1. <a href="${escapeHtml(app.htmlUrl)}/installations/new">Install the GitHub App</a> on the repositories the agent should work on.</p>
<p>2. Add at least one Agent provider. Each one runs on that provider's own subscription.</p>
<form method="post" action="/setup/providers">
<label>Claude <small>output of <code>claude setup-token</code></small>${set(record.providers.claudeToken)}<input type="password" name="claude_token" autocomplete="off"></label>
<label>Codex <small>contents of <code>~/.codex/auth.json</code> after <code>codex login</code></small>${set(record.providers.codexAuth)}<textarea name="codex_auth" rows="4" autocomplete="off"></textarea></label>
<label>opencode <small>GLM Coding Plan API key</small>${set(record.providers.zaiApiKey)}<input type="password" name="zai_api_key" autocomplete="off"></label>
<label><input type="checkbox" name="mutations_enabled"${record.mutationsEnabled ? " checked" : ""}> Let the agent write to GitHub <small>comments, labels, pull requests, pushes</small></label>
<button type="submit">Save and start</button>
</form>
<h2>Dashboard</h2>
<p>Open <a href="${escapeHtml(origin)}/">${escapeHtml(origin)}/</a> and sign in as <code>${DASHBOARD_USER}</code> with this password. Save it now. This page shows it again only after you sign in with it.</p>
<p class="box"><code>${escapeHtml(record.dashboardPassword ?? "")}</code></p>`
  );
}
__name(providersPage, "providersPage");
async function canEditProviders(request, record) {
  return await hasSession(request, record) || await hasDashboardPassword(request, record);
}
__name(canEditProviders, "canEditProviders");
async function saveProviders(request, dependencies2, record) {
  if (request.headers.get("origin") !== new URL(request.url).origin)
    return new Response("Request origin is not allowed.", { status: 403 });
  const form = await request.formData();
  const text = /* @__PURE__ */ __name((name) => {
    const value = form.get(name);
    return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
  }, "text");
  const codexAuth = text("codex_auth");
  if (codexAuth !== null) {
    try {
      JSON.parse(codexAuth);
    } catch {
      return page(
        "Codex login is not JSON",
        '<h1>Codex login is not JSON</h1><p>Paste the whole <code>~/.codex/auth.json</code>. <a href="/setup/providers">Back</a>.</p>',
        {
          status: 400
        }
      );
    }
  }
  const next = {
    ...record,
    providers: {
      claudeToken: text("claude_token") ?? record.providers.claudeToken,
      codexAuth: codexAuth ?? record.providers.codexAuth,
      zaiApiKey: text("zai_api_key") ?? record.providers.zaiApiKey
    },
    mutationsEnabled: form.get("mutations_enabled") === "on"
  };
  await dependencies2.store.write(next);
  await dependencies2.store.restart({ forgetCodexLogin: codexAuth !== null });
  return providersPage(next, new URL(request.url).origin, true);
}
__name(saveProviders, "saveProviders");
async function handleSetup(request, dependencies2) {
  const url = new URL(request.url);
  if (url.pathname !== "/setup" && !url.pathname.startsWith("/setup/")) return null;
  const record = await dependencies2.store.read();
  switch (`${request.method} ${url.pathname}`) {
    case "GET /setup":
      if (record.app !== null) return redirect("/setup/providers");
      return startSetup(request, dependencies2, record);
    case "GET /setup/callback":
      if (record.app !== null) return redirect("/setup/providers");
      return finishManifest(request, dependencies2, record);
    case "GET /setup/providers":
      if (record.app === null) return redirect("/setup");
      if (!await canEditProviders(request, record)) return unauthorized();
      return providersPage(record, url.origin, false);
    case "POST /setup/providers":
      if (record.app === null) return redirect("/setup");
      if (!await canEditProviders(request, record)) return unauthorized();
      return saveProviders(request, dependencies2, record);
    case "GET /setup/installed":
      if (record.app !== null && isReady(record) && await canEditProviders(request, record))
        await dependencies2.store.restart({ forgetCodexLogin: false });
      return redirect(isReady(record) ? "/" : "/setup/providers");
    default:
      return new Response("Not found.", { status: 404 });
  }
}
__name(handleSetup, "handleSetup");

// src/signature.ts
var encoder = new TextEncoder();
async function verifyWebhookSignature(secret, body, signature) {
  if (signature === null || !/^sha256=[0-9a-f]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "verify"
  ]);
  return crypto.subtle.verify("HMAC", key, hexBytes(signature.slice("sha256=".length)), body);
}
__name(verifyWebhookSignature, "verifyWebhookSignature");
function hexBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index++)
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  return bytes;
}
__name(hexBytes, "hexBytes");

// src/webhook.ts
var MAXIMUM_BODY_BYTES = 25 * 1024 * 1024;
var MAXIMUM_INLINE_BYTES = 100 * 1024;
var MAXIMUM_RETRY_DELAY_SECONDS = 15 * 60;
async function acceptWebhook(request, dependencies2) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAXIMUM_BODY_BYTES) return new Response("Body is too large.", { status: 413 });
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > MAXIMUM_BODY_BYTES) return new Response("Body is too large.", { status: 413 });
  const secret = (await dependencies2.controller.readSetup()).app?.webhookSecret;
  if (secret === void 0) return new Response("Setup is not complete.", { status: 503 });
  const signature = request.headers.get("x-hub-signature-256");
  if (signature === null || !await verifyWebhookSignature(secret, bytes, signature)) {
    return new Response("Signature mismatch.", { status: 401 });
  }
  const delivery = request.headers.get("x-github-delivery");
  if (delivery === null || !/^[\w-]{1,128}$/.test(delivery))
    return new Response("Delivery identity is missing or invalid.", { status: 400 });
  const event = request.headers.get("x-github-event") ?? "";
  const text = new TextDecoder().decode(bytes);
  let body;
  if (bytes.byteLength <= MAXIMUM_INLINE_BYTES) {
    body = { _tag: "Inline", text };
  } else {
    const key = `deliveries/${delivery}`;
    await dependencies2.bodies.put(key, text);
    body = { _tag: "Stored", key };
  }
  await dependencies2.webhooks.send({ delivery, event, signature, body });
  return new Response(null, { status: 204 });
}
__name(acceptWebhook, "acceptWebhook");
async function relayDelivery(message, dependencies2) {
  let text;
  if (message.body._tag === "Inline") {
    text = message.body.text;
  } else {
    const object = await dependencies2.bodies.get(message.body.key);
    if (object === null) return { _tag: "Rejected", status: 410 };
    text = await object.text();
  }
  let status;
  try {
    status = await dependencies2.controller.relayWebhook({
      delivery: message.delivery,
      event: message.event,
      signature: message.signature,
      text
    });
  } catch {
    return { _tag: "Retry" };
  }
  if (status === null) return { _tag: "Rejected", status: 503 };
  if (status >= 200 && status < 300) return { _tag: "Delivered" };
  if (status >= 500 || status === 408 || status === 429) return { _tag: "Retry" };
  return { _tag: "Rejected", status };
}
__name(relayDelivery, "relayDelivery");
function retryDelaySeconds(attempts) {
  return Math.min(MAXIMUM_RETRY_DELAY_SECONDS, 5 * 2 ** Math.max(1, attempts));
}
__name(retryDelaySeconds, "retryDelaySeconds");
async function consumeWebhooks(batch, dependencies2) {
  for (const message of batch.messages) {
    const outcome = await relayDelivery(message.body, dependencies2);
    if (outcome._tag === "Retry") {
      message.retry({ delaySeconds: retryDelaySeconds(message.attempts) });
      continue;
    }
    if (outcome._tag === "Rejected")
      console.error(`Webhook ${message.body.delivery} (${message.body.event}) was rejected with ${outcome.status}.`);
    if (message.body.body._tag === "Stored") await dependencies2.bodies.delete(message.body.body.key);
    message.ack();
  }
}
__name(consumeWebhooks, "consumeWebhooks");

// src/app.ts
function parseAllowedOwners(value) {
  return (value ?? "").split(",").map((owner) => owner.trim()).filter((owner) => owner !== "");
}
__name(parseAllowedOwners, "parseAllowedOwners");
async function handleRequest(request, dependencies2) {
  const url = new URL(request.url);
  if (url.protocol === "http:") {
    url.protocol = "https:";
    return Response.redirect(url.toString(), 308);
  }
  if (url.pathname === "/webhook") {
    if (request.method !== "POST") return new Response("Method not allowed.", { status: 405 });
    return acceptWebhook(request, {
      controller: dependencies2.controller,
      webhooks: dependencies2.webhooks,
      bodies: dependencies2.state
    });
  }
  const setup = await handleSetup(request, {
    store: {
      read: dependencies2.controller.readSetup,
      write: dependencies2.controller.writeSetup,
      restart: dependencies2.controller.restart
    },
    allowedOwners: dependencies2.allowedOwners,
    fetch: dependencies2.fetch,
    now: dependencies2.now
  });
  if (setup !== null) return setup;
  if (!isReady(await dependencies2.controller.readSetup())) return Response.redirect(`${url.origin}/setup`, 303);
  return proxyDashboard(request, dependencies2.controller);
}
__name(handleRequest, "handleRequest");
async function handleQueue(batch, dependencies2) {
  await consumeWebhooks(batch, {
    controller: dependencies2.controller,
    webhooks: dependencies2.webhooks,
    bodies: dependencies2.state
  });
}
__name(handleQueue, "handleQueue");

// src/controller.ts
var SETUP_KEY = "setup";
var DASHBOARD_PORT = 8080;
var WEBHOOK_PORT = 8081;
var STATE_FILES = /* @__PURE__ */ new Set(["state.sqlite", "codex-auth.json"]);
var stateFiles = /* @__PURE__ */ __name(async (request, env) => {
  const name = new URL(request.url).pathname.replace(/^\/files\//, "");
  if (!STATE_FILES.has(name)) return new Response("Not found.", { status: 404 });
  const key = `controller/${name}`;
  if (request.method === "GET") {
    const object = await env.STATE.get(key);
    return object === null ? new Response("Not found.", { status: 404 }) : new Response(object.body);
  }
  if (request.method === "PUT") {
    await env.STATE.put(key, request.body);
    return new Response(null, { status: 204 });
  }
  return new Response("Method not allowed.", { status: 405 });
}, "stateFiles");
var ControllerContainer = class extends Container {
  static {
    __name(this, "ControllerContainer");
  }
  defaultPort = DASHBOARD_PORT;
  requiredPorts = [DASHBOARD_PORT, WEBHOOK_PORT];
  sleepAfter = "1h";
  enableInternet = true;
  static {
    this.outboundByHost = { "state.internal": stateFiles };
  }
  /** The controller polls GitHub and runs Routines on its own clock, so it never sleeps. */
  async onActivityExpired() {
    this.renewActivityTimeout();
  }
  async readSetup() {
    return { ...EMPTY_SETUP, ...await this.ctx.storage.get(SETUP_KEY) };
  }
  async writeSetup(record) {
    await this.ctx.storage.put(SETUP_KEY, record);
  }
  /** Loads the start environment from the setup record. False until setup is complete. */
  async prepare() {
    const record = await this.readSetup();
    if (!isReady(record)) return false;
    this.envVars = controllerEnvironment(record, this.env.ALLOWED_OWNERS);
    return true;
  }
  async ensureRunning() {
    if (!await this.prepare()) return;
    await this.startAndWaitForPorts({ ports: [DASHBOARD_PORT, WEBHOOK_PORT] });
  }
  async restart(options) {
    if (options.forgetCodexLogin) await this.env.STATE.delete("controller/codex-auth.json");
    const state = await this.getState();
    if (state.status === "running" || state.status === "healthy") {
      await this.stop("SIGTERM");
    }
    await this.ensureRunning().catch((error) => console.warn("The controller did not start yet.", error));
  }
  async relayWebhook(delivery) {
    if (!await this.prepare()) return null;
    const response = await this.containerFetch(
      new Request("http://127.0.0.1/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-delivery": delivery.delivery,
          "x-github-event": delivery.event,
          "x-hub-signature-256": delivery.signature
        },
        body: delivery.text
      }),
      WEBHOOK_PORT
    );
    await response.body?.cancel();
    return response.status;
  }
  async proxyDashboard(request) {
    if (!await this.prepare()) return new Response("Setup is not complete.", { status: 503 });
    return this.containerFetch(request, DASHBOARD_PORT);
  }
};
function controllerEnvironment(record, allowedOwners) {
  const app = record.app;
  return {
    WOLFSTAR_GITHUB_APP_ID: String(app.id),
    WOLFSTAR_GITHUB_APP_PRIVATE_KEY: app.privateKey,
    WOLFSTAR_GITHUB_WEBHOOK_SECRET: app.webhookSecret,
    WOLFSTAR_DASHBOARD_PASSWORD: record.dashboardPassword ?? "",
    WOLFSTAR_ALLOWED_OWNERS: allowedOwners,
    WOLFSTAR_GIT_NAME: app.gitName,
    WOLFSTAR_GIT_EMAIL: app.gitEmail,
    WOLFSTAR_MUTATIONS_ENABLED: String(record.mutationsEnabled),
    WOLFSTAR_ISSUE_CUTOFF: record.issueCutoff ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10),
    CLAUDE_CODE_OAUTH_TOKEN: record.providers.claudeToken ?? "",
    WOLFSTAR_CODEX_AUTH_JSON: record.providers.codexAuth ?? "",
    WOLFSTAR_ZAI_API_KEY: record.providers.zaiApiKey ?? ""
  };
}
__name(controllerEnvironment, "controllerEnvironment");

// src/index.ts
function controller(env) {
  return env.CONTROLLER.get(env.CONTROLLER.idFromName("controller"));
}
__name(controller, "controller");
function dependencies(env) {
  return {
    controller: controller(env),
    webhooks: env.WEBHOOKS,
    state: env.STATE,
    allowedOwners: parseAllowedOwners(env.ALLOWED_OWNERS),
    fetch: /* @__PURE__ */ __name((input, init) => fetch(input, init), "fetch"),
    now: Date.now
  };
}
__name(dependencies, "dependencies");
var index_default = {
  async fetch(request, env) {
    return handleRequest(request, dependencies(env));
  },
  async queue(batch, env) {
    await handleQueue(batch, dependencies(env));
  },
  /** A deploy or a host move can stop the Container. The cron brings it back within minutes. */
  async scheduled(_controller, env) {
    await controller(env).ensureRunning();
  }
};
export {
  ContainerProxy,
  ControllerContainer,
  index_default as default
};
//# sourceMappingURL=index.js.map
