import type { RoutingStrategy } from "../config/types.js";
import type { ModelTaskType } from "./taskType.js";

export interface RouteOptions {
  strategy?: RoutingStrategy;
  sensitive?: boolean;
  forceClient?: string;
  taskType?: ModelTaskType;
}
