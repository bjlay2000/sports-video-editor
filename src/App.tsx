import { useEffect } from "react";
import {
  Panel,
  PanelGroup,
  PanelResizeHandle,
} from "react-resizable-panels";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { Toolbar } from "./components/Toolbar";
import { VideoPlayer } from "./components/video/VideoPlayer";
import { ScoringPanel } from "./components/scoring/ScoringPanel";
import { TimelinePanel } from "./components/timeline/TimelinePanel";
import { PlayerSelectModal } from "./components/scoring/PlayerSelectModal";
import { HighlightExportModal } from "./components/scoring/HighlightExportModal";
import { ExportStatsModal } from "./components/scoring/ExportStatsModal.tsx";
import { AddPlayerModal } from "./components/scoring/AddPlayerModal";
import { CustomTitleBar } from "./components/system/CustomTitleBar";
import { ToastHost } from "./components/system/ToastHost";
import { ExportProgressModal } from "./components/export/ExportProgressModal";
import { DatabaseService } from "./services/DatabaseService";
import { useAppStore } from "./store/appStore";

export default function App() {
  const setPlayers = useAppStore((s) => s.setPlayers);
  const setPlays = useAppStore((s) => s.setPlays);
  const setGame = useAppStore((s) => s.setGame);
  const setMarkers = useAppStore((s) => s.setMarkers);
  const showPlayerModal = useAppStore((s) => s.showPlayerModal);
  const showHighlightModal = useAppStore((s) => s.showHighlightModal);
  const showExportStatsModal = useAppStore((s) => s.showExportStatsModal);
  const showAddPlayerModal = useAppStore((s) => s.showAddPlayerModal);

  // Ctrl+Shift+D → toggle debug inspector window
  useEffect(() => {
    const handleKeyDown = async (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key === "D") {
        e.preventDefault();
        try {
          const existing = await WebviewWindow.getByLabel("debug_inspector");
          if (existing) {
            await existing.close();
          } else {
            new WebviewWindow("debug_inspector", {
              url: "debug.html",
              title: "SVE Debug Inspector",
              width: 420,
              height: 800,
              x: 0,
              y: 100,
              alwaysOnTop: true,
              decorations: false,
              resizable: true,
              transparent: true,
            });
          }
        } catch (err) {
          console.error("Failed to toggle debug window:", err);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    const load = async () => {
      try {
        const [players, plays, game] = await Promise.all([
          DatabaseService.getPlayers(),
          DatabaseService.getPlays(),
          DatabaseService.getGame(),
        ]);
        setPlayers(players);
        setPlays(plays);
        setGame(game);
        setMarkers(
          plays.map((p) => ({
            id: p.id,
            time: p.timestamp,
            event_type: p.event_type,
            player_name: p.player_name,
            start_time: p.start_time,
            end_time: p.end_time,
            label: p.event_type,
          }))
        );
      } catch (e) {
        console.error("Failed to load initial data:", e);
      }
    };
    load();
  }, []);

  return (
    <div className="flex flex-col h-screen w-screen bg-surface">
      <CustomTitleBar />
      <Toolbar />
      <PanelGroup direction="vertical" className="flex-1">
        <Panel defaultSize={65} minSize={30}>
          <PanelGroup direction="horizontal" className="h-full">
            <Panel defaultSize={65} minSize={30}>
              <VideoPlayer />
            </Panel>
            <PanelResizeHandle className="w-1.5 bg-panel-border hover:bg-accent transition-colors cursor-col-resize" />
            <Panel defaultSize={35} minSize={20}>
              <ScoringPanel />
            </Panel>
          </PanelGroup>
        </Panel>
        <PanelResizeHandle className="h-1.5 bg-panel-border hover:bg-accent transition-colors cursor-row-resize" />
        <Panel defaultSize={35} minSize={15}>
          <TimelinePanel />
        </Panel>
      </PanelGroup>
      {showPlayerModal && <PlayerSelectModal />}
      {showHighlightModal && <HighlightExportModal />}
      {showExportStatsModal && <ExportStatsModal />}
      {showAddPlayerModal && <AddPlayerModal />}
      <ExportProgressModal />
      <ToastHost />
    </div>
  );
}
