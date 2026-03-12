#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::Manager;

pub struct DbState(pub Mutex<Option<Connection>>);

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Player {
    pub id: i64,
    pub name: String,
    pub number: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Play {
    pub id: i64,
    pub timestamp: f64,
    pub player_id: i64,
    pub event_type: String,
    pub start_time: f64,
    pub end_time: f64,
    pub player_name: Option<String>,
    pub player_number: Option<i32>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Game {
    pub id: i64,
    pub home_score: i32,
    pub away_score: i32,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ClipRange {
    pub start_time: f64,
    pub end_time: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TimelineClip {
    pub id: String,
    pub start_time: f64,
    pub end_time: f64,
    pub sort_order: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlayerShift {
    pub id: i64,
    pub player_id: i64,
    pub enter_time: f64,
    pub exit_time: Option<f64>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub auto_generated_from_play_id: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ScoreEvent {
    pub id: i64,
    pub team: String,
    pub time: f64,
    pub score: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct StatRecordResult {
    pub play: Play,
    pub game: Game,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlayerPlayedPercentage {
    pub player_id: i64,
    pub played_seconds: f64,
    pub total_duration: f64,
    pub percent_played: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Roster {
    pub roster_id: i64,
    pub name: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RosterPlayer {
    pub roster_player_id: i64,
    pub roster_id: i64,
    pub name: String,
    pub number: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RosterPlayerInput {
    pub name: String,
    pub number: i32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct OpponentStat {
    pub id: i64,
    pub timestamp: f64,
    pub event_type: String,
}

pub fn init_db(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT
        );

        CREATE TABLE IF NOT EXISTS players (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            number INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS plays (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            player_id INTEGER NOT NULL,
            event_type TEXT NOT NULL,
            start_time REAL NOT NULL,
            end_time REAL NOT NULL,
            FOREIGN KEY (player_id) REFERENCES players(id)
        );

        CREATE TABLE IF NOT EXISTS games (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            home_score INTEGER NOT NULL DEFAULT 0,
            away_score INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS timeline_clips (
            id TEXT PRIMARY KEY,
            start_time REAL NOT NULL,
            end_time REAL NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS player_shifts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_id INTEGER NOT NULL,
            enter_time REAL NOT NULL,
            exit_time REAL,
            source TEXT NOT NULL DEFAULT 'manual_sub',
            auto_generated_from_play_id TEXT NULL,
            FOREIGN KEY (player_id) REFERENCES players(id)
        );

        CREATE TABLE IF NOT EXISTS score_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            team TEXT NOT NULL,
            time REAL NOT NULL,
            score INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_timeline_sort ON timeline_clips(sort_order);
        CREATE INDEX IF NOT EXISTS idx_shifts_player ON player_shifts(player_id);
        CREATE INDEX IF NOT EXISTS idx_shifts_enter ON player_shifts(enter_time);
        CREATE INDEX IF NOT EXISTS idx_plays_timestamp ON plays(timestamp);
        CREATE INDEX IF NOT EXISTS idx_plays_player ON plays(player_id);
        CREATE INDEX IF NOT EXISTS idx_plays_event ON plays(event_type);
        CREATE TABLE IF NOT EXISTS opponent_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp REAL NOT NULL,
            event_type TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_score_events_team ON score_events(team, time);
        CREATE INDEX IF NOT EXISTS idx_opponent_stats_event ON opponent_stats(event_type);
        ",
    )
    .map_err(|e| format!("Failed to initialize database: {}", e))?;

    // Schema versioning
    let version: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .ok();

    if version.is_none() {
        conn.execute(
            "INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '1')",
            [],
        )
        .map_err(|e| format!("Failed to set schema version: {}", e))?;
    }

    // Ensure default game row
    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
        .unwrap_or(0);

    if count == 0 {
        conn.execute("INSERT INTO games (home_score, away_score) VALUES (0, 0)", [])
            .ok();
    }

    // Backward-compatible migration for existing DBs created before source columns.
    if let Err(err) = conn.execute(
        "ALTER TABLE player_shifts ADD COLUMN source TEXT NOT NULL DEFAULT 'manual_sub'",
        [],
    ) {
        if !err.to_string().contains("duplicate column name") {
            return Err(format!("Failed to add player_shifts.source column: {}", err));
        }
    }

    if let Err(err) = conn.execute(
        "ALTER TABLE player_shifts ADD COLUMN auto_generated_from_play_id TEXT NULL",
        [],
    ) {
        if !err.to_string().contains("duplicate column name") {
            return Err(format!(
                "Failed to add player_shifts.auto_generated_from_play_id column: {}",
                err
            ));
        }
    }

    // Create this index after the migrations above ensure the columns exist.
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_shifts_source_play ON player_shifts(source, auto_generated_from_play_id);",
    )
    .map_err(|e| format!("Failed to create idx_shifts_source_play index: {}", e))?;

    Ok(())
}

fn open_rosters_db(app: &tauri::AppHandle) -> Result<Connection, String> {
    let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let db_dir = app_data.join("sve-data");
    std::fs::create_dir_all(&db_dir).map_err(|e| e.to_string())?;
    let db_path = db_dir.join("rosters.db");
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA foreign_keys = ON;",
    )
    .map_err(|e| e.to_string())?;

    conn.execute_batch(
        "
        CREATE TABLE IF NOT EXISTS rosters (
            roster_id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS roster_players (
            roster_player_id INTEGER PRIMARY KEY AUTOINCREMENT,
            roster_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            number INTEGER NOT NULL,
            FOREIGN KEY (roster_id) REFERENCES rosters(roster_id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_rosters_updated_at ON rosters(updated_at);
        CREATE INDEX IF NOT EXISTS idx_roster_players_roster_id ON roster_players(roster_id);
        CREATE INDEX IF NOT EXISTS idx_roster_players_number ON roster_players(number);
        ",
    )
    .map_err(|e| e.to_string())?;

    Ok(conn)
}

fn monitor_log_candidates() -> Vec<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(cwd) = std::env::current_dir() {
        candidates.push(cwd.join("ffmpeg-monitor.log"));
        if let Some(parent) = cwd.parent() {
            candidates.push(parent.join("ffmpeg-monitor.log"));
        }
    }
    candidates
}

fn resolve_monitor_log_path() -> Option<PathBuf> {
    let candidates = monitor_log_candidates();
    candidates
        .iter()
        .find(|p| p.exists())
        .cloned()
        .or_else(|| candidates.first().cloned())
}

fn reset_ffmpeg_monitor_log() {
    let now = chrono_like_now();
    let header = format!(
        "=== monitor started {} (reset on app launch) ===\n",
        now
    );

    // Prefer truncating an existing monitor log, otherwise create one in current dir.
    let target = resolve_monitor_log_path();

    if let Some(path) = target {
        match OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&path)
        {
            Ok(mut file) => {
                let _ = file.write_all(header.as_bytes());
                let _ = file.flush();
                println!("[startup] reset monitor log: {}", path.display());
            }
            Err(err) => {
                eprintln!(
                    "[startup] failed to reset monitor log {}: {}",
                    path.display(),
                    err
                );
            }
        }
    }
}

fn chrono_like_now() -> String {
    // RFC3339-style enough for diagnostics without adding external crates.
    // Example: 2026-02-23T10:14:12.123Z
    let now = std::time::SystemTime::now();
    let datetime: chrono_like::DateTime = now.into();
    datetime.to_string()
}

mod chrono_like {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    pub struct DateTime {
        pub year: i32,
        pub month: u32,
        pub day: u32,
        pub hour: u32,
        pub minute: u32,
        pub second: u32,
        pub millis: u32,
    }

    impl From<SystemTime> for DateTime {
        fn from(value: SystemTime) -> Self {
            let duration = value
                .duration_since(UNIX_EPOCH)
                .unwrap_or(Duration::from_secs(0));
            let secs = duration.as_secs() as i64;
            let millis = duration.subsec_millis();

            // UTC conversion based on civil-from-days algorithm.
            let days = secs.div_euclid(86_400);
            let sod = secs.rem_euclid(86_400);

            let z = days + 719_468;
            let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
            let doe = z - era * 146_097;
            let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
            let mut year = (yoe + era * 400) as i32;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
            let month = (mp + if mp < 10 { 3 } else { -9 }) as u32;
            if month <= 2 {
                year += 1;
            }

            let hour = (sod / 3600) as u32;
            let minute = ((sod % 3600) / 60) as u32;
            let second = (sod % 60) as u32;

            DateTime {
                year,
                month,
                day,
                hour,
                minute,
                second,
                millis,
            }
        }
    }

    impl std::fmt::Display for DateTime {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(
                f,
                "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                self.year,
                self.month,
                self.day,
                self.hour,
                self.minute,
                self.second,
                self.millis
            )
        }
    }
}

mod commands {
    use super::{
        chrono_like_now, open_rosters_db, resolve_monitor_log_path, ClipRange,
        DbState, Game, OpponentStat, Play, Player, PlayerPlayedPercentage, PlayerShift,
        Roster, RosterPlayer, RosterPlayerInput, ScoreEvent, StatRecordResult, TimelineClip,
    };
    use rusqlite::params;
    use std::{
        collections::{HashMap, HashSet},
        fs,
        io::{BufRead, BufReader, Write},
        process::{Command, Stdio},
    };
    use tauri::{async_runtime, Emitter, Manager, State};

    #[tauri::command]
    pub fn add_player(
        state: State<DbState>,
        name: String,
        number: i32,
    ) -> Result<Player, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute(
            "INSERT INTO players (name, number) VALUES (?1, ?2)",
            params![name, number],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        Ok(Player { id, name, number })
    }

    #[tauri::command]
    pub fn get_players(state: State<DbState>) -> Result<Vec<Player>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare("SELECT id, name, number FROM players ORDER BY number")
            .map_err(|e| e.to_string())?;

        let players = stmt
            .query_map([], |row| {
                Ok(Player {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    number: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(players)
    }

    #[tauri::command]
    pub fn ensure_exports_dir() -> Result<String, String> {
        let mut path = std::env::current_dir().map_err(|e| e.to_string())?;
        path.push("exports");
        fs::create_dir_all(&path).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub fn append_ffmpeg_monitor_log(line: String) -> Result<(), String> {
        let Some(path) = resolve_monitor_log_path() else {
            return Err("Unable to resolve ffmpeg-monitor.log path".into());
        };

        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
            .map_err(|e| e.to_string())?;

        writeln!(file, "{}", line).map_err(|e| e.to_string())?;
        file.flush().map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn delete_player(state: State<DbState>, id: i64) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute("DELETE FROM plays WHERE player_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM players WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn add_play(
        state: State<DbState>,
        timestamp: f64,
        player_id: i64,
        event_type: String,
        start_time: f64,
        end_time: f64,
    ) -> Result<Play, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute(
            "INSERT INTO plays (timestamp, player_id, event_type, start_time, end_time) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![timestamp, player_id, event_type, start_time, end_time],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number
                FROM plays p
                LEFT JOIN players pl ON pl.id = p.player_id
                WHERE p.id = ?1",
            )
            .map_err(|e| e.to_string())?;

        stmt
            .query_row(params![id], |row| {
                Ok(Play {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    player_id: row.get(2)?,
                    event_type: row.get(3)?,
                    start_time: row.get(4)?,
                    end_time: row.get(5)?,
                    player_name: row.get(6).ok(),
                    player_number: row.get(7).ok(),
                })
            })
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_plays(state: State<DbState>) -> Result<Vec<Play>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number
                FROM plays p
                LEFT JOIN players pl ON pl.id = p.player_id
                ORDER BY p.timestamp",
            )
            .map_err(|e| e.to_string())?;

        let plays = stmt
            .query_map([], |row| {
                Ok(Play {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    player_id: row.get(2)?,
                    event_type: row.get(3)?,
                    start_time: row.get(4)?,
                    end_time: row.get(5)?,
                    player_name: row.get(6).ok(),
                    player_number: row.get(7).ok(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(plays)
    }

    #[tauri::command]
    pub fn delete_play(state: State<DbState>, id: i64) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

        let result = (|| -> Result<(), String> {
            let play_row: Option<(i64, f64)> = conn
                .query_row(
                    "SELECT player_id, timestamp FROM plays WHERE id = ?1",
                    params![id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .ok();

            conn.execute("DELETE FROM plays WHERE id = ?1", params![id])
                .map_err(|e| e.to_string())?;

            let generated_key = id.to_string();
            let mut shift_stmt = conn
                .prepare(
                    "SELECT id, player_id, enter_time, exit_time
                     FROM player_shifts
                     WHERE source = 'auto_stat' AND auto_generated_from_play_id = ?1",
                )
                .map_err(|e| e.to_string())?;

            let auto_shifts: Vec<(i64, i64, f64, Option<f64>)> = shift_stmt
                .query_map(params![generated_key], |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                    ))
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            for (shift_id, shift_player_id, shift_enter, shift_exit) in auto_shifts {
                let lower = shift_enter;
                let upper = shift_exit;

                let other_plays_count: i64 = if let Some(upper_bound) = upper {
                    conn.query_row(
                        "SELECT COUNT(*)
                         FROM plays
                         WHERE player_id = ?1
                           AND id <> ?2
                           AND timestamp >= ?3
                           AND timestamp < ?4",
                        params![shift_player_id, id, lower, upper_bound],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?
                } else {
                    conn.query_row(
                        "SELECT COUNT(*)
                         FROM plays
                         WHERE player_id = ?1
                           AND id <> ?2
                           AND timestamp >= ?3",
                        params![shift_player_id, id, lower],
                        |row| row.get(0),
                    )
                    .map_err(|e| e.to_string())?
                };

                if other_plays_count == 0 {
                    conn.execute("DELETE FROM player_shifts WHERE id = ?1", params![shift_id])
                        .map_err(|e| e.to_string())?;
                }
            }

            // keep compiler happy for unused fetch in older DB edge cases
            let _ = play_row;
            Ok(())
        })();

        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }

        result
    }

    #[tauri::command]
    pub fn update_play_window(
        state: State<DbState>,
        id: i64,
        timestamp: f64,
        start_time: f64,
        end_time: f64,
    ) -> Result<Play, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute(
            "UPDATE plays SET timestamp = ?2, start_time = ?3, end_time = ?4 WHERE id = ?1",
            params![id, timestamp, start_time, end_time],
        )
        .map_err(|e| e.to_string())?;

        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number
                FROM plays p
                LEFT JOIN players pl ON pl.id = p.player_id
                WHERE p.id = ?1",
            )
            .map_err(|e| e.to_string())?;

        stmt
            .query_row(params![id], |row| {
                Ok(Play {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    player_id: row.get(2)?,
                    event_type: row.get(3)?,
                    start_time: row.get(4)?,
                    end_time: row.get(5)?,
                    player_name: row.get(6).ok(),
                    player_number: row.get(7).ok(),
                })
            })
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn update_play_event_and_player(
        state: State<DbState>,
        id: i64,
        event_type: Option<String>,
        player_id: Option<i64>,
    ) -> Result<Play, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        if let Some(ref et) = event_type {
            conn.execute(
                "UPDATE plays SET event_type = ?2 WHERE id = ?1",
                params![id, et],
            )
            .map_err(|e| e.to_string())?;
        }
        if let Some(pid) = player_id {
            conn.execute(
                "UPDATE plays SET player_id = ?2 WHERE id = ?1",
                params![id, pid],
            )
            .map_err(|e| e.to_string())?;
        }
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number
                FROM plays p
                LEFT JOIN players pl ON pl.id = p.player_id
                WHERE p.id = ?1",
            )
            .map_err(|e| e.to_string())?;
        stmt
            .query_row(params![id], |row| {
                Ok(Play {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    player_id: row.get(2)?,
                    event_type: row.get(3)?,
                    start_time: row.get(4)?,
                    end_time: row.get(5)?,
                    player_name: row.get(6).ok(),
                    player_number: row.get(7).ok(),
                })
            })
            .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn get_plays_by_type(
        state: State<DbState>,
        event_type: String,
    ) -> Result<Vec<Play>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare(
                "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number
                FROM plays p
                LEFT JOIN players pl ON pl.id = p.player_id
                WHERE p.event_type = ?1
                ORDER BY p.timestamp",
            )
            .map_err(|e| e.to_string())?;

        let plays = stmt
            .query_map(params![event_type], |row| {
                Ok(Play {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    player_id: row.get(2)?,
                    event_type: row.get(3)?,
                    start_time: row.get(4)?,
                    end_time: row.get(5)?,
                    player_name: row.get(6).ok(),
                    player_number: row.get(7).ok(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(plays)
    }

    #[tauri::command]
    pub fn update_score(
        state: State<DbState>,
        home_score: i32,
        away_score: i32,
    ) -> Result<Game, String> {
        {
            let guard = state.0.lock().map_err(|e| e.to_string())?;
            let conn = guard.as_ref().ok_or("No project database is open")?;
            conn.execute(
                "UPDATE games SET home_score = ?1, away_score = ?2 WHERE id = 1",
                params![home_score, away_score],
            )
            .map_err(|e| e.to_string())?;
        }
        get_game(state)
    }

    #[tauri::command]
    pub fn get_game(state: State<DbState>) -> Result<Game, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.query_row(
            "SELECT id, home_score, away_score FROM games WHERE id = 1",
            [],
            |row| {
                Ok(Game {
                    id: row.get(0)?,
                    home_score: row.get(1)?,
                    away_score: row.get(2)?,
                })
            },
        )
        .map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn open_project_db(
        app: tauri::AppHandle,
        state: State<DbState>,
        project_id: String,
    ) -> Result<String, String> {
        let app_data = app.path().app_data_dir().map_err(|e| e.to_string())?;
        let db_dir = app_data.join("sve-data");
        fs::create_dir_all(&db_dir).map_err(|e| e.to_string())?;
        let db_path = db_dir.join(format!("{}.db", project_id));
        let conn =
            rusqlite::Connection::open(&db_path).map_err(|e| e.to_string())?;

        // Performance pragmas + WAL
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             PRAGMA temp_store = MEMORY;
             PRAGMA foreign_keys = ON;",
        )
        .map_err(|e| e.to_string())?;

        // Verify WAL is active
        let journal_mode: String = conn
            .query_row("PRAGMA journal_mode", [], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        println!("[open_project_db] journal_mode = {}", journal_mode);

        super::init_db(&conn)?;

        let mut guard = state.0.lock().map_err(|e| e.to_string())?;
        *guard = Some(conn);
        Ok(db_path.to_string_lossy().to_string())
    }

    #[tauri::command]
    pub fn save_timeline_clips(
        state: State<DbState>,
        clips: Vec<TimelineClip>,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM timeline_clips", [])
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "INSERT INTO timeline_clips (id, start_time, end_time, sort_order) VALUES (?1, ?2, ?3, ?4)",
                )
                .map_err(|e| e.to_string())?;
            for (i, clip) in clips.iter().enumerate() {
                stmt.execute(params![clip.id, clip.start_time, clip.end_time, i as i32])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    #[tauri::command]
    pub fn get_timeline_clips(state: State<DbState>) -> Result<Vec<TimelineClip>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, start_time, end_time, sort_order FROM timeline_clips ORDER BY sort_order",
            )
            .map_err(|e| e.to_string())?;
        let clips = stmt
            .query_map([], |row| {
                Ok(TimelineClip {
                    id: row.get(0)?,
                    start_time: row.get(1)?,
                    end_time: row.get(2)?,
                    sort_order: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(clips)
    }

    #[tauri::command]
    pub fn save_player_shifts(
        state: State<DbState>,
        shifts: Vec<PlayerShift>,
    ) -> Result<(), String> {
        // Step 7: Enforce one open shift per player
        let mut open_shift_players = HashSet::new();
        for shift in &shifts {
            if shift.exit_time.is_none() {
                if !open_shift_players.insert(shift.player_id) {
                    return Err(format!(
                        "Player {} has multiple open shifts",
                        shift.player_id
                    ));
                }
            }
        }

        // Step 8: Prevent overlapping shifts per player
        let mut by_player: HashMap<i64, Vec<&PlayerShift>> = HashMap::new();
        for shift in &shifts {
            by_player.entry(shift.player_id).or_default().push(shift);
        }
        for (player_id, player_shifts) in &by_player {
            for i in 0..player_shifts.len() {
                for j in (i + 1)..player_shifts.len() {
                    let a = player_shifts[i];
                    let b = player_shifts[j];
                    let a_end = a.exit_time.unwrap_or(f64::MAX);
                    let b_end = b.exit_time.unwrap_or(f64::MAX);
                    if a.enter_time < b_end && b.enter_time < a_end {
                        return Err(format!(
                            "Overlapping shifts detected for player {}",
                            player_id
                        ));
                    }
                }
            }
        }

        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM player_shifts", [])
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "INSERT INTO player_shifts (player_id, enter_time, exit_time, source, auto_generated_from_play_id) VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| e.to_string())?;
            for shift in &shifts {
                let source = shift.source.as_deref().unwrap_or("manual_sub");
                stmt.execute(params![
                    shift.player_id,
                    shift.enter_time,
                    shift.exit_time,
                    source,
                    shift.auto_generated_from_play_id
                ])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    #[tauri::command]
    pub fn get_player_shifts(state: State<DbState>) -> Result<Vec<PlayerShift>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare(
                "SELECT id, player_id, enter_time, exit_time, source, auto_generated_from_play_id FROM player_shifts ORDER BY enter_time",
            )
            .map_err(|e| e.to_string())?;
        let shifts = stmt
            .query_map([], |row| {
                Ok(PlayerShift {
                    id: row.get(0)?,
                    player_id: row.get(1)?,
                    enter_time: row.get(2)?,
                    exit_time: row.get(3)?,
                    source: row.get(4).ok(),
                    auto_generated_from_play_id: row.get(5).ok(),
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(shifts)
    }

    #[tauri::command]
    pub fn save_score_events(
        state: State<DbState>,
        events: Vec<ScoreEvent>,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM score_events", [])
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "INSERT INTO score_events (team, time, score) VALUES (?1, ?2, ?3)",
                )
                .map_err(|e| e.to_string())?;
            for event in &events {
                stmt.execute(params![event.team, event.time, event.score])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    #[tauri::command]
    pub fn get_score_events(state: State<DbState>) -> Result<Vec<ScoreEvent>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare("SELECT id, team, time, score FROM score_events ORDER BY time")
            .map_err(|e| e.to_string())?;
        let events = stmt
            .query_map([], |row| {
                Ok(ScoreEvent {
                    id: row.get(0)?,
                    team: row.get(1)?,
                    time: row.get(2)?,
                    score: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(events)
    }

    // ── opponent stats (team-level, no FK dependency on players) ──

    #[tauri::command]
    pub fn save_opponent_stats(
        state: State<DbState>,
        stats: Vec<OpponentStat>,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM opponent_stats", [])
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "INSERT INTO opponent_stats (timestamp, event_type) VALUES (?1, ?2)",
                )
                .map_err(|e| e.to_string())?;
            for s in &stats {
                stmt.execute(params![s.timestamp, s.event_type])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    #[tauri::command]
    pub fn get_opponent_stats(state: State<DbState>) -> Result<Vec<OpponentStat>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let mut stmt = conn
            .prepare("SELECT id, timestamp, event_type FROM opponent_stats ORDER BY timestamp")
            .map_err(|e| e.to_string())?;
        let stats = stmt
            .query_map([], |row| {
                Ok(OpponentStat {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    event_type: row.get(2)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(stats)
    }

    #[tauri::command]
    pub fn add_opponent_stat(
        state: State<DbState>,
        timestamp: f64,
        event_type: String,
    ) -> Result<OpponentStat, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute(
            "INSERT INTO opponent_stats (timestamp, event_type) VALUES (?1, ?2)",
            params![timestamp, event_type],
        )
        .map_err(|e| e.to_string())?;
        let id = conn.last_insert_rowid();
        Ok(OpponentStat {
            id,
            timestamp,
            event_type,
        })
    }

    #[tauri::command]
    pub fn delete_opponent_stat(state: State<DbState>, id: i64) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute("DELETE FROM opponent_stats WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn save_players_bulk(
        state: State<DbState>,
        players: Vec<Player>,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM players", [])
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("INSERT INTO players (id, name, number) VALUES (?1, ?2, ?3)")
                .map_err(|e| e.to_string())?;
            for p in &players {
                stmt.execute(params![p.id, p.name, p.number])
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    #[tauri::command]
    pub fn save_plays_bulk(
        state: State<DbState>,
        plays: Vec<Play>,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute("DELETE FROM plays", [])
                .map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare(
                    "INSERT INTO plays (id, timestamp, player_id, event_type, start_time, end_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                )
                .map_err(|e| e.to_string())?;
            for p in &plays {
                stmt.execute(params![
                    p.id,
                    p.timestamp,
                    p.player_id,
                    p.event_type,
                    p.start_time,
                    p.end_time
                ])
                .map_err(|e| e.to_string())?;
            }
            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    #[tauri::command]
    pub fn generate_ffmpeg_concat(
        video_path: String,
        clips: Vec<ClipRange>,
        output_path: String,
        overlay_path: Option<String>,
    ) -> Result<Vec<String>, String> {
        if clips.is_empty() {
            return Err("At least one clip is required".into());
        }

        let mut filter_parts = Vec::new();
        let mut concat_inputs = String::new();
        for (idx, clip) in clips.iter().enumerate() {
            filter_parts.push(format!(
                "[0:v]trim=start={}:end={},setpts=PTS-STARTPTS[v{}];",
                clip.start_time, clip.end_time, idx
            ));
            filter_parts.push(format!(
                "[0:a]atrim=start={}:end={},asetpts=PTS-STARTPTS[a{}];",
                clip.start_time, clip.end_time, idx
            ));
            concat_inputs.push_str(&format!("[v{}][a{}]", idx, idx));
        }

        let concat_statement = format!(
            "{}concat=n={}:v=1:a=1[vout][aout]",
            concat_inputs,
            clips.len()
        );

        let mut video_output_label = String::from("[vout]");
        if overlay_path.is_some() {
            filter_parts.push(format!("{};", concat_statement));
            filter_parts.push("[1:v]format=rgba[overlay];".into());
            filter_parts.push("[vout][overlay]overlay=0:0:format=auto[ovout]".into());
            video_output_label = String::from("[ovout]");
        } else {
            filter_parts.push(concat_statement);
        }

        let filter = filter_parts.join(" ");

        let mut args = vec![
            "-y".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            "-i".into(),
            video_path,
        ];

        if let Some(path) = overlay_path {
            args.push("-loop".into());
            args.push("1".into());
            args.push("-i".into());
            args.push(path);
        }

        args.push("-filter_complex".into());
        args.push(filter);
        args.push("-map".into());
        args.push(video_output_label);
        args.push("-map".into());
        args.push("[aout]".into());
        args.push("-c:v".into());
        args.push("libx264".into());
        args.push("-preset".into());
        args.push("veryfast".into());
        args.push("-crf".into());
        args.push("20".into());
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
        args.push(output_path);

        Ok(args)
    }

    #[tauri::command]
    pub async fn run_ffmpeg(
        app: tauri::AppHandle,
        program: String,
        args: Vec<String>,
        progress_event: Option<String>,
    ) -> Result<String, String> {
        let result = async_runtime::spawn_blocking(move || -> Result<(), String> {
            let mut child = Command::new(program)
                .args(args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| e.to_string())?;

            if let Some(stdout) = child.stdout.take() {
                let reader = BufReader::new(stdout);
                for line in reader.lines() {
                    let line = line.map_err(|e| e.to_string())?;
                    if let Some(event_name) = &progress_event {
                        let _ = app.emit(event_name, line.clone());
                    }
                }
            }

            let status = child.wait().map_err(|e| e.to_string())?;
            if status.success() {
                Ok(())
            } else {
                Err(format!("ffmpeg exited with status: {}", status))
            }
        })
        .await
        .map_err(|e| e.to_string())?;

        result?;
        Ok("ffmpeg completed".into())
    }

    // Step 9: Close open shifts on project load
    #[tauri::command]
    pub fn close_open_shifts(
        state: State<DbState>,
        project_duration: f64,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute(
            "UPDATE player_shifts SET exit_time = ?1 WHERE exit_time IS NULL",
            params![project_duration],
        )
        .map_err(|e| e.to_string())?;
        Ok(())
    }

    // Step 10: Atomic V1 → V2 migration
    #[tauri::command]
    pub fn migrate_v1_to_v2(
        state: State<DbState>,
        players: Vec<Player>,
        plays: Vec<Play>,
        home_score: i32,
        away_score: i32,
        timeline_clips: Vec<TimelineClip>,
        shifts: Vec<PlayerShift>,
        score_events: Vec<ScoreEvent>,
    ) -> Result<(), String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            // Players
            conn.execute("DELETE FROM players", [])
                .map_err(|e| e.to_string())?;
            {
                let mut stmt = conn
                    .prepare("INSERT INTO players (id, name, number) VALUES (?1, ?2, ?3)")
                    .map_err(|e| e.to_string())?;
                for p in &players {
                    stmt.execute(params![p.id, p.name, p.number])
                        .map_err(|e| e.to_string())?;
                }
            }

            // Plays
            conn.execute("DELETE FROM plays", [])
                .map_err(|e| e.to_string())?;
            {
                let mut stmt = conn
                    .prepare(
                        "INSERT INTO plays (id, timestamp, player_id, event_type, start_time, end_time) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                    )
                    .map_err(|e| e.to_string())?;
                for p in &plays {
                    stmt.execute(params![
                        p.id,
                        p.timestamp,
                        p.player_id,
                        p.event_type,
                        p.start_time,
                        p.end_time
                    ])
                    .map_err(|e| e.to_string())?;
                }
            }

            // Game score
            conn.execute(
                "UPDATE games SET home_score = ?1, away_score = ?2 WHERE id = 1",
                params![home_score, away_score],
            )
            .map_err(|e| e.to_string())?;

            // Timeline clips
            conn.execute("DELETE FROM timeline_clips", [])
                .map_err(|e| e.to_string())?;
            {
                let mut stmt = conn
                    .prepare(
                        "INSERT INTO timeline_clips (id, start_time, end_time, sort_order) VALUES (?1, ?2, ?3, ?4)",
                    )
                    .map_err(|e| e.to_string())?;
                for (i, c) in timeline_clips.iter().enumerate() {
                    stmt.execute(params![c.id, c.start_time, c.end_time, i as i32])
                        .map_err(|e| e.to_string())?;
                }
            }

            // Player shifts
            conn.execute("DELETE FROM player_shifts", [])
                .map_err(|e| e.to_string())?;
            {
                let mut stmt = conn
                    .prepare(
                        "INSERT INTO player_shifts (player_id, enter_time, exit_time) VALUES (?1, ?2, ?3)",
                    )
                    .map_err(|e| e.to_string())?;
                for s in &shifts {
                    stmt.execute(params![s.player_id, s.enter_time, s.exit_time])
                        .map_err(|e| e.to_string())?;
                }
            }

            // Score events
            conn.execute("DELETE FROM score_events", [])
                .map_err(|e| e.to_string())?;
            {
                let mut stmt = conn
                    .prepare(
                        "INSERT INTO score_events (team, time, score) VALUES (?1, ?2, ?3)",
                    )
                    .map_err(|e| e.to_string())?;
                for ev in &score_events {
                    stmt.execute(params![ev.team, ev.time, ev.score])
                        .map_err(|e| e.to_string())?;
                }
            }

            Ok(())
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    // Step 14: Transactional stat recording with side effects
    #[tauri::command]
    pub fn record_stat_with_side_effects(
        state: State<DbState>,
        timestamp: f64,
        player_id: i64,
        event_type: String,
        start_time: f64,
        end_time: f64,
        score_delta: Option<i32>,
        ensure_on_court: bool,
        court_enter_time: f64,
    ) -> Result<StatRecordResult, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<StatRecordResult, String> {
            // Insert play
            conn.execute(
                "INSERT INTO plays (timestamp, player_id, event_type, start_time, end_time) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![timestamp, player_id, event_type, start_time, end_time],
            )
            .map_err(|e| e.to_string())?;
            let id = conn.last_insert_rowid();

            // Score update
            if let Some(delta) = score_delta {
                conn.execute(
                    "UPDATE games SET home_score = home_score + ?1 WHERE id = 1",
                    params![delta],
                )
                .map_err(|e| e.to_string())?;
            }

            // Ensure player on court: add shift if no open shift exists
            if ensure_on_court {
                let open_count: i64 = conn
                    .query_row(
                        "SELECT COUNT(*) FROM player_shifts WHERE player_id = ?1 AND exit_time IS NULL",
                        params![player_id],
                        |row| row.get(0),
                    )
                    .unwrap_or(0);
                if open_count == 0 {
                    conn.execute(
                        "INSERT INTO player_shifts (player_id, enter_time, exit_time, source, auto_generated_from_play_id) VALUES (?1, ?2, NULL, 'auto_stat', ?3)",
                        params![player_id, court_enter_time, id.to_string()],
                    )
                    .map_err(|e| e.to_string())?;
                }
            }

            // Fetch created play with player info
            let mut stmt = conn
                .prepare(
                    "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number
                     FROM plays p LEFT JOIN players pl ON pl.id = p.player_id WHERE p.id = ?1",
                )
                .map_err(|e| e.to_string())?;
            let play = stmt
                .query_row(params![id], |row| {
                    Ok(Play {
                        id: row.get(0)?,
                        timestamp: row.get(1)?,
                        player_id: row.get(2)?,
                        event_type: row.get(3)?,
                        start_time: row.get(4)?,
                        end_time: row.get(5)?,
                        player_name: row.get(6).ok(),
                        player_number: row.get(7).ok(),
                    })
                })
                .map_err(|e| e.to_string())?;

            // Fetch updated game
            let game = conn
                .query_row(
                    "SELECT id, home_score, away_score FROM games WHERE id = 1",
                    [],
                    |row| {
                        Ok(Game {
                            id: row.get(0)?,
                            home_score: row.get(1)?,
                            away_score: row.get(2)?,
                        })
                    },
                )
                .map_err(|e| e.to_string())?;

            Ok(StatRecordResult { play, game })
        })();
        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }
        result
    }

    // Step 16: EXPLAIN QUERY PLAN debug command
    #[tauri::command]
    pub fn explain_query_plans(state: State<DbState>) -> Result<Vec<String>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;
        let queries = [
            "SELECT id, start_time, end_time, sort_order FROM timeline_clips ORDER BY sort_order",
            "SELECT id, player_id, enter_time, exit_time FROM player_shifts ORDER BY enter_time",
            "SELECT p.id, p.timestamp, p.player_id, p.event_type, p.start_time, p.end_time, pl.name, pl.number FROM plays p LEFT JOIN players pl ON pl.id = p.player_id ORDER BY p.timestamp",
        ];
        let mut results = Vec::new();
        for query in &queries {
            let explain = format!("EXPLAIN QUERY PLAN {}", query);
            let mut stmt = conn.prepare(&explain).map_err(|e| e.to_string())?;
            let rows: Vec<String> = stmt
                .query_map([], |row| {
                    let detail: String = row.get(3)?;
                    Ok(detail)
                })
                .map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();
            results.push(format!("Query: {}\nPlan: {}", query, rows.join("; ")));
        }
        Ok(results)
    }

    #[tauri::command]
    pub fn get_played_percentages(
        state: State<DbState>,
    ) -> Result<Vec<PlayerPlayedPercentage>, String> {
        let guard = state.0.lock().map_err(|e| e.to_string())?;
        let conn = guard.as_ref().ok_or("No project database is open")?;

        let sql = r#"
            WITH total AS (
                SELECT COALESCE(SUM(MAX(0, end_time - start_time)), 0.0) AS total_duration
                FROM timeline_clips
            ),
            per_player AS (
                SELECT
                    p.id AS player_id,
                    COALESCE(
                        SUM(
                            CASE
                                WHEN (
                                    MIN(COALESCE(s.exit_time, c.end_time), c.end_time)
                                    - MAX(s.enter_time, c.start_time)
                                ) > 0
                                THEN (
                                    MIN(COALESCE(s.exit_time, c.end_time), c.end_time)
                                    - MAX(s.enter_time, c.start_time)
                                )
                                ELSE 0
                            END
                        ),
                        0.0
                    ) AS played_seconds
                FROM players p
                LEFT JOIN player_shifts s
                    ON s.player_id = p.id
                LEFT JOIN timeline_clips c
                    ON s.player_id IS NOT NULL
                   AND c.end_time > s.enter_time
                   AND c.start_time < COALESCE(s.exit_time, c.end_time)
                GROUP BY p.id
            )
            SELECT
                pp.player_id,
                pp.played_seconds,
                t.total_duration,
                CASE
                    WHEN t.total_duration > 0
                    THEN (pp.played_seconds / t.total_duration) * 100.0
                    ELSE 0.0
                END AS percent_played
            FROM per_player pp
            CROSS JOIN total t
            ORDER BY pp.player_id
        "#;

        let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |row| {
                Ok(PlayerPlayedPercentage {
                    player_id: row.get(0)?,
                    played_seconds: row.get(1)?,
                    total_duration: row.get(2)?,
                    percent_played: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
    }

    #[tauri::command]
    pub fn create_roster(app: tauri::AppHandle, name: String) -> Result<Roster, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err("Roster name is required".into());
        }

        let conn = open_rosters_db(&app)?;
        let now = chrono_like_now();

        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<Roster, String> {
            conn.execute(
                "INSERT INTO rosters (name, created_at, updated_at) VALUES (?1, ?2, ?3)",
                params![trimmed, now.clone(), now.clone()],
            )
            .map_err(|e| e.to_string())?;
            let roster_id = conn.last_insert_rowid();
            Ok(Roster {
                roster_id,
                name: trimmed.to_string(),
                created_at: now.clone(),
                updated_at: now,
            })
        })();

        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }

        result
    }

    #[tauri::command]
    pub fn delete_roster(app: tauri::AppHandle, roster_id: i64) -> Result<(), String> {
        let conn = open_rosters_db(&app)?;
        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute(
                "DELETE FROM roster_players WHERE roster_id = ?1",
                params![roster_id],
            )
            .map_err(|e| e.to_string())?;
            conn.execute("DELETE FROM rosters WHERE roster_id = ?1", params![roster_id])
                .map_err(|e| e.to_string())?;
            Ok(())
        })();

        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }

        result
    }

    #[tauri::command]
    pub fn get_rosters(app: tauri::AppHandle) -> Result<Vec<Roster>, String> {
        let conn = open_rosters_db(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT roster_id, name, created_at, updated_at FROM rosters ORDER BY updated_at DESC, roster_id DESC",
            )
            .map_err(|e| e.to_string())?;
        let rosters = stmt
            .query_map([], |row| {
                Ok(Roster {
                    roster_id: row.get(0)?,
                    name: row.get(1)?,
                    created_at: row.get(2)?,
                    updated_at: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rosters)
    }

    #[tauri::command]
    pub fn get_roster_players(
        app: tauri::AppHandle,
        roster_id: i64,
    ) -> Result<Vec<RosterPlayer>, String> {
        let conn = open_rosters_db(&app)?;
        let mut stmt = conn
            .prepare(
                "SELECT roster_player_id, roster_id, name, number FROM roster_players WHERE roster_id = ?1 ORDER BY number, roster_player_id",
            )
            .map_err(|e| e.to_string())?;
        let players = stmt
            .query_map(params![roster_id], |row| {
                Ok(RosterPlayer {
                    roster_player_id: row.get(0)?,
                    roster_id: row.get(1)?,
                    name: row.get(2)?,
                    number: row.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        Ok(players)
    }

    #[tauri::command]
    pub fn save_roster_players(
        app: tauri::AppHandle,
        roster_id: i64,
        players: Vec<RosterPlayerInput>,
    ) -> Result<(), String> {
        let conn = open_rosters_db(&app)?;
        let now = chrono_like_now();

        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
        let result = (|| -> Result<(), String> {
            conn.execute(
                "UPDATE rosters SET updated_at = ?2 WHERE roster_id = ?1",
                params![roster_id, now],
            )
            .map_err(|e| e.to_string())?;

            conn.execute(
                "DELETE FROM roster_players WHERE roster_id = ?1",
                params![roster_id],
            )
            .map_err(|e| e.to_string())?;

            let mut stmt = conn
                .prepare(
                    "INSERT INTO roster_players (roster_id, name, number) VALUES (?1, ?2, ?3)",
                )
                .map_err(|e| e.to_string())?;
            for player in &players {
                stmt.execute(params![roster_id, player.name, player.number])
                    .map_err(|e| e.to_string())?;
            }

            Ok(())
        })();

        if result.is_ok() {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
        } else {
            let _ = conn.execute_batch("ROLLBACK");
        }

        result
    }

    #[tauri::command]
    pub fn open_file_path(path: String) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .arg("/C")
                .arg("start")
                .arg("")
                .arg(&path)
                .status()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Err("open_file_path is currently implemented for Windows only".to_string())
        }
    }

    #[tauri::command]
    pub fn reveal_file_in_folder(path: String) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("explorer")
                .arg("/select,")
                .arg(&path)
                .status()
                .map_err(|e| e.to_string())?;
            return Ok(());
        }

        #[cfg(not(target_os = "windows"))]
        {
            let _ = path;
            Err("reveal_file_in_folder is currently implemented for Windows only".to_string())
        }
    }

}

fn main() {
    reset_ffmpeg_monitor_log();

    // No global DB opened at startup — DB opens only after open_project_db(project_id)
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            if let Err(err) = open_rosters_db(&app.handle()) {
                eprintln!("[startup] failed to open rosters db: {}", err);
                return Err(std::io::Error::new(std::io::ErrorKind::Other, err).into());
            }

            let icon = tauri::include_image!("icons/icon.png");

            if let Some(main_window) = app.get_webview_window("main") {
                if let Err(err) = main_window.set_icon(icon) {
                    eprintln!("[startup] failed to set main window icon: {}", err);
                }
            }
            Ok(())
        })
        .manage(DbState(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![
            commands::add_player,
            commands::get_players,
            commands::delete_player,
            commands::add_play,
            commands::get_plays,
            commands::get_plays_by_type,
            commands::delete_play,
            commands::update_play_window,
            commands::update_play_event_and_player,
            commands::update_score,
            commands::get_game,
            commands::open_project_db,
            commands::save_timeline_clips,
            commands::get_timeline_clips,
            commands::save_player_shifts,
            commands::get_player_shifts,
            commands::save_score_events,
            commands::get_score_events,
            commands::save_opponent_stats,
            commands::get_opponent_stats,
            commands::add_opponent_stat,
            commands::delete_opponent_stat,
            commands::save_players_bulk,
            commands::save_plays_bulk,
            commands::ensure_exports_dir,
            commands::append_ffmpeg_monitor_log,
            commands::generate_ffmpeg_concat,
            commands::run_ffmpeg,
            commands::close_open_shifts,
            commands::migrate_v1_to_v2,
            commands::record_stat_with_side_effects,
            commands::get_played_percentages,
            commands::explain_query_plans,
            commands::create_roster,
            commands::delete_roster,
            commands::get_rosters,
            commands::get_roster_players,
            commands::save_roster_players,
            commands::open_file_path,
            commands::reveal_file_in_folder
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
