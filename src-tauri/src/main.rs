#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Mutex;

pub struct DbState(pub Mutex<Connection>);

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

pub fn get_db_path() -> PathBuf {
    let mut path = std::env::current_dir().unwrap_or_default();
    path.push("database.sqlite");
    path
}

pub fn init_db(conn: &Connection) {
    conn.execute_batch(
        "
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
        ",
    )
    .expect("Failed to initialize database");

    let count: i64 = conn
        .query_row("SELECT COUNT(*) FROM games", [], |row| row.get(0))
        .unwrap_or(0);

    if count == 0 {
        conn.execute("INSERT INTO games (home_score, away_score) VALUES (0, 0)", [])
            .ok();
    }
}

// ---- COMMANDS ----

mod commands {
    use super::{ClipRange, DbState, Game, Play, Player};
    use rusqlite::params;
    use std::{
        fs,
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    use tauri::{async_runtime, Emitter, State};
    use serde_json::json;

    #[tauri::command]
    pub fn add_player(
        state: State<DbState>,
        name: String,
        number: i32,
    ) -> Result<Player, String> {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO players (name, number) VALUES (?1, ?2)",
            rusqlite::params![name, number],
        )
        .map_err(|e| e.to_string())?;

        let id = conn.last_insert_rowid();
        Ok(Player { id, name, number })
    }

    #[tauri::command]
    pub fn get_players(state: State<DbState>) -> Result<Vec<Player>, String> {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
    pub fn delete_player(state: State<DbState>, id: i64) -> Result<(), String> {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM plays WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    #[tauri::command]
    pub fn update_play_window(
        state: State<DbState>,
        id: i64,
        timestamp: f64,
        start_time: f64,
        end_time: f64,
    ) -> Result<Play, String> {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
    pub fn get_plays_by_type(
        state: State<DbState>,
        event_type: String,
    ) -> Result<Vec<Play>, String> {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
        let conn = state.0.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE games SET home_score = ?1, away_score = ?2 WHERE id = 1",
            params![home_score, away_score],
        )
        .map_err(|e| e.to_string())?;
        drop(conn);
        get_game(state)
    }

    #[tauri::command]
    pub fn get_game(state: State<DbState>) -> Result<Game, String> {
        let conn = state.0.lock().map_err(|e| e.to_string())?;
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
        app_handle: tauri::AppHandle,
        program: String,
        args: Vec<String>,
        progress_event: Option<String>,
    ) -> Result<String, String> {
        const ALLOWED: [&str; 2] = ["ffmpeg", "ffmpeg.exe"];
        let exec_name = ALLOWED
            .iter()
            .find(|allowed| allowed.eq_ignore_ascii_case(program.as_str()))
            .ok_or_else(|| "Program not permitted".to_string())?
            .to_string();
        let ffmpeg_args = args;
        let event_name = progress_event.clone();
        let handle = app_handle.clone();

        let output = async_runtime::spawn_blocking(move || {
            let mut command = Command::new(exec_name);
            command.args(&ffmpeg_args);
            if event_name.is_some() {
                command.stdout(Stdio::piped());
            }
            command.stderr(Stdio::piped());

            let mut child = command.spawn()?;

            if let Some(event_label) = event_name {
                if let Some(stdout) = child.stdout.take() {
                    let mut reader = BufReader::new(stdout);
                    let emitter = handle.clone();
                    std::thread::spawn(move || {
                        let mut line = String::new();
                        loop {
                            line.clear();
                            match reader.read_line(&mut line) {
                                Ok(0) => break,
                                Ok(_) => {
                                    let trimmed = line.trim();
                                    if trimmed.is_empty() {
                                        continue;
                                    }
                                    if let Some((key, value)) = trimmed.split_once('=') {
                                        let payload = json!({
                                            "key": key,
                                            "value": value,
                                        });
                                        let _ = emitter.emit(&event_label, payload);
                                    }
                                }
                                Err(_) => break,
                            }
                        }
                    });
                }
            }

            child.wait_with_output()
        })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

        if output.status.success() {
            Ok(String::from_utf8_lossy(&output.stdout).to_string())
        } else {
            Err(String::from_utf8_lossy(&output.stderr).to_string())
        }
    }
}

fn main() {
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).expect("Failed to open database");
    init_db(&conn);

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .manage(DbState(Mutex::new(conn)))
        .invoke_handler(tauri::generate_handler![
            commands::add_player,
            commands::get_players,
            commands::delete_player,
            commands::add_play,
            commands::get_plays,
            commands::get_plays_by_type,
            commands::delete_play,
            commands::update_play_window,
            commands::update_score,
            commands::get_game,
            commands::ensure_exports_dir,
            commands::generate_ffmpeg_concat,
            commands::run_ffmpeg
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
