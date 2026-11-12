"use strict";
class ConnectionSettings {
  constructor({ connectors, loginGoogle }) {
    this.connectors = connectors;
    this.loginGoogle = loginGoogle;
  }
  snapshot() {
    const c = this.connectors,
      configured = c.describe();
    return { connections: configured, catalog: c.catalog() };
  }
  async dispatch(request = {}) {
    if (!request || typeof request !== "object" || Array.isArray(request))
      throw new Error("Invalid connection request");
    const c = this.connectors;
    switch (request.action || "status") {
      case "status":
        await c.refreshStatuses();
        break;
      case "connect": {
        if (!c.catalog().some((x) => x.id === request.id))
          throw new Error("Choose an available service");
        if (!c.config.some((x) => x.id === request.id))
          await c.add({ recipe: request.id }, undefined, {
            hostApproved: true,
          });
        const status = await c.test(request.id);
        if (["gmail", "calendar"].includes(request.id) && !status.authenticated)
          await this.loginGoogle();
        break;
      }
      case "test":
        await c.test(request.id);
        break;
      case "remove":
        c.get(request.id);
        await c.update((current) => current.filter((x) => x.id !== request.id));
        break;
      case "automatic": {
        if (typeof request.enabled !== "boolean")
          throw new Error("Choose whether to allow background tasks");
        c.get(request.id);
        await c.update((current) =>
          current.map((x) =>
            x.id === request.id ? { ...x, automatic: request.enabled } : x,
          ),
        );
        break;
      }
      case "add": {
        const d = request.definition;
        if (!d || typeof d !== "object" || Array.isArray(d))
          throw new Error("Enter a connection definition");
        if (c.config.some((x) => x.id === d.id))
          throw new Error(
            "This connection already exists. Use a different name.",
          );
        await c.add(d, undefined, { hostApproved: true });
        break;
      }
      default:
        throw new Error("Unknown connection action");
    }
    return this.snapshot();
  }
}
module.exports = { ConnectionSettings };
