import { z } from "zod";
import { CuyError } from "../core/errors.js";
import { defineTool } from "../core/registry.js";
import { auditPath, loadPolicy, policyPath } from "../core/security/policy.js";

export default defineTool({
  name: "policy_show",
  description: "Muestra la política de seguridad activa.",
  params: z.strictObject({}),
  risk: "read",
  handler: async () => {
    try {
      const policy = loadPolicy();
      return { path: policyPath(), valid: true, audit_path: auditPath(policy), policy,
        capabilities: { exactOrigins: true, localNetwork: true, visitLeases: true, strictResources: false } };
    } catch (err) {
      if (err instanceof CuyError) return { path: policyPath(), valid: false, error: err.message };
      throw err;
    }
  },
});
