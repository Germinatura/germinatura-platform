import handler from "vinext/server/fetch-handler";
import { forwardPortalApi, isPortalApiPath, type PortalWorkerBinding } from "./lib/portal-worker-proxy";

interface PdvWorkerEnv {
  PORTAL_API?: PortalWorkerBinding;
}

const worker = {
  ...handler,
  async fetch(request: Request, env: PdvWorkerEnv, context: unknown): Promise<Response> {
    if (isPortalApiPath(new URL(request.url).pathname)) {
      return forwardPortalApi(request, env.PORTAL_API, process.env.NEXT_PUBLIC_PORTAL_URL);
    }
    return handler.fetch(request, env, context);
  },
};

export default worker;
