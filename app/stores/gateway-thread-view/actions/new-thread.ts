import { useGatewayBootstrapStore } from "@/stores/gateway-bootstrap";
import { useGatewayCatalogStore } from "@/stores/gateway-catalog";
import { useGatewayNavigationStore } from "@/stores/gateway-navigation";
import { useGatewayThreadViewStore } from "@/stores/gateway-thread-view";
import {
  activateThreadView,
  beginViewTransition,
  cacheSelectedThreadView,
  syncSelectedRoute,
} from "@/stores/gateway/thread-open/view-state";

export function prepareNewThread(context?: { hostId: number; projectId: number }) {
  const navigation = useGatewayNavigationStore();
  const hostId = context?.hostId ?? navigation.selectedHostId;
  const projectId = context?.projectId ?? navigation.selectedProjectId;
  if (hostId === null || projectId === null) return;
  const catalog = useGatewayCatalogStore();
  const views = useGatewayThreadViewStore();
  cacheSelectedThreadView();
  beginViewTransition();
  activateThreadView(hostId, projectId);
  views.newThreadDraftActive = true;
  views.newThreadDraftToken += 1;
  useGatewayBootstrapStore().clearError();
  if (catalog.modelsHostId !== hostId) {
    catalog.models = [];
    catalog.defaultModelProvider = null;
    catalog.modelsHostId = null;
  }
  syncSelectedRoute();
  void catalog.ensureSelectedHostModels();
  void navigation.listThreads();
}
