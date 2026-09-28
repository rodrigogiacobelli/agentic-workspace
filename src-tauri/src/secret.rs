//! Key passphrases in the desktop's wallet, through the freedesktop Secret
//! Service over D-Bus: GNOME Keyring, KWallet or KeePassXC, whichever owns
//! `org.freedesktop.secrets`. The application keeps no wallet of its own
//! (CRED-02).
//!
//! Every operation opens its own session connection and drops it when done.
//! A connection runs its tasks on the runtime it was made on, and the askpass
//! threads reach this through `block_on` on Tauri's; one kept in a static
//! would outlive the context it belongs to.

use crate::desktop::APP_ID;
use futures_util::StreamExt;
use std::collections::HashMap;
use std::future::Future;
use std::time::Duration;
use zbus::zvariant::{ObjectPath, OwnedObjectPath, OwnedValue, Value};
use zbus::Connection;

const SERVICE: &str = "org.freedesktop.secrets";
const SERVICE_PATH: &str = "/org/freedesktop/secrets";
const SERVICE_IFACE: &str = "org.freedesktop.Secret.Service";
const COLLECTION_IFACE: &str = "org.freedesktop.Secret.Collection";
const ITEM_IFACE: &str = "org.freedesktop.Secret.Item";
const PROMPT_IFACE: &str = "org.freedesktop.Secret.Prompt";
const PROPERTIES_IFACE: &str = "org.freedesktop.DBus.Properties";

/// How long a whole operation may take. An unlock dialog waits on a person,
/// and KeePassXC holds a read open while it asks its user to confirm; a push
/// must not wait on either forever (CRED-09).
const LIMIT: Duration = Duration::from_secs(120);

/// A secret on the wire: session, parameters, value, content type.
type Wire = (OwnedObjectPath, Vec<u8>, Vec<u8>, String);

pub enum SecretError {
    /// Nothing answers the Secret Service.
    NoWallet(String),
    /// The wallet was asked to unlock and did not: the dialog was dismissed,
    /// or nobody answered it in time.
    StayedLocked,
    Failed(String),
}

impl std::fmt::Display for SecretError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SecretError::NoWallet(why) => write!(f, "no wallet answers ({why})"),
            SecretError::StayedLocked => write!(f, "the wallet stayed locked"),
            SecretError::Failed(why) => write!(f, "{why}"),
        }
    }
}

fn failed(e: impl std::fmt::Display) -> SecretError {
    SecretError::Failed(e.to_string())
}

/// A bus call's failure. A name nobody owns, and nothing can start, is no
/// wallet at all rather than a wallet that failed.
fn from_bus(e: zbus::Error) -> SecretError {
    match &e {
        zbus::Error::MethodError(name, ..)
            if matches!(name.as_str(), "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner") =>
        {
            SecretError::NoWallet(e.to_string())
        }
        _ => failed(e),
    }
}

async fn bounded<T>(work: impl Future<Output = Result<T, SecretError>>, late: SecretError) -> Result<T, SecretError> {
    tokio::time::timeout(LIMIT, work).await.unwrap_or(Err(late))
}

/// The attributes every item of this build carries. Every search, lookup and
/// delete matches both, so a development build never touches an installed
/// build's passphrases: the two carry different `APP_ID`s.
fn attributes(id: &str) -> HashMap<&str, &str> {
    HashMap::from([("application", APP_ID), ("credential", id)])
}

/// A connection with a `plain` session open on it: the transport is the
/// user's own session bus, which the Secret Service specification allows.
struct Session {
    conn: Connection,
    path: OwnedObjectPath,
}

impl Session {
    async fn open() -> Result<Self, SecretError> {
        let conn = Connection::session().await.map_err(|e| SecretError::NoWallet(e.to_string()))?;
        let (_, path): (OwnedValue, OwnedObjectPath) = call(&conn, SERVICE_PATH, SERVICE_IFACE, "OpenSession", &("plain", Value::from(""))).await?;
        Ok(Self { conn, path })
    }

    async fn search(&self, id: &str) -> Result<(Vec<OwnedObjectPath>, Vec<OwnedObjectPath>), SecretError> {
        call(&self.conn, SERVICE_PATH, SERVICE_IFACE, "SearchItems", &(attributes(id),)).await
    }

    /// Unlocks `objects`, showing the wallet's own dialog when it has one.
    async fn unlock(&self, objects: &[OwnedObjectPath]) -> Result<(), SecretError> {
        let paths: Vec<ObjectPath> = objects.iter().map(|p| p.as_ref()).collect();
        let (_, prompt): (Vec<OwnedObjectPath>, OwnedObjectPath) = call(&self.conn, SERVICE_PATH, SERVICE_IFACE, "Unlock", &(paths,)).await?;
        self.prompt(&prompt).await
    }

    /// Runs a prompt the service handed back; `/` means none was needed.
    async fn prompt(&self, prompt: &OwnedObjectPath) -> Result<(), SecretError> {
        if prompt.as_str() == "/" {
            return Ok(());
        }
        // Subscribed before `Prompt` is called: a wallet that is already
        // unlocked by then completes at once, and the signal would be missed.
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface(PROMPT_IFACE)
            .and_then(|r| r.member("Completed"))
            .and_then(|r| r.path(prompt.as_str()))
            .map_err(failed)?
            .build();
        let mut completed = zbus::MessageStream::for_match_rule(rule, &self.conn, None).await.map_err(from_bus)?;
        let () = call(&self.conn, prompt.as_str(), PROMPT_IFACE, "Prompt", &("",)).await?;
        // The wallet's own dialog is left on screen when the bound ends: the
        // Secret Service `Dismiss` call aborts gnome-keyring-daemon 50.0
        // (assertion in gkd-secret-unlock.c perform_next_unlock), which would
        // take every client's keyring down. Answered later, it just unlocks.
        while let Some(message) = completed.next().await {
            let Ok(message) = message else { continue };
            let (dismissed, _): (bool, OwnedValue) = message.body().deserialize().map_err(failed)?;
            return if dismissed { Err(SecretError::StayedLocked) } else { Ok(()) };
        }
        Err(SecretError::StayedLocked)
    }
}

async fn call<B, R>(conn: &Connection, path: &str, iface: &str, method: &str, body: &B) -> Result<R, SecretError>
where
    B: serde::Serialize + zbus::zvariant::DynamicType,
    R: for<'d> zbus::zvariant::DynamicDeserialize<'d>,
{
    let reply = conn.call_method(Some(SERVICE), path, Some(iface), method, body).await.map_err(from_bus)?;
    reply.body().deserialize().map_err(failed)
}

/// Which wallet answers, by name, or why none does. A service that is not
/// running but can be started is started, through a property read.
pub async fn probe() -> Result<String, String> {
    bounded(
        async {
            let conn = Connection::session().await.map_err(|e| SecretError::NoWallet(e.to_string()))?;
            let dbus = zbus::fdo::DBusProxy::new(&conn).await.map_err(failed)?;
            let name = zbus::names::BusName::try_from(SERVICE).map_err(failed)?;
            if dbus.get_name_owner(name.clone()).await.is_err() {
                let activatable = dbus.list_activatable_names().await.map_err(failed)?;
                if !activatable.iter().any(|n| n.as_str() == SERVICE) {
                    return Err(SecretError::NoWallet("nothing provides org.freedesktop.secrets".into()));
                }
                let _: OwnedValue = call(&conn, SERVICE_PATH, PROPERTIES_IFACE, "Get", &(SERVICE_IFACE, "Collections")).await?;
            }
            let pid = dbus.get_connection_unix_process_id(name).await.map_err(failed)?;
            // A service that cannot open a session cannot keep a passphrase.
            Session::open().await?;
            let exe = std::fs::read_link(format!("/proc/{pid}/exe")).ok();
            let program = exe.as_deref().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            Ok(match program.as_str() {
                "gnome-keyring-daemon" => "GNOME Keyring".to_string(),
                "ksecretd" | "kwalletd6" | "kwalletd5" => "KWallet".to_string(),
                "keepassxc" => "KeePassXC".to_string(),
                "" => SERVICE.to_string(),
                other => other.to_string(),
            })
        },
        SecretError::Failed("the wallet did not answer".into()),
    )
    .await
    .map_err(|e| e.to_string())
}

/// Whether the wallet holds a passphrase for the credential, without asking
/// it to unlock: a locked item is still found.
pub async fn exists(id: &str) -> Result<bool, SecretError> {
    bounded(
        async {
            let session = Session::open().await?;
            let (unlocked, locked) = session.search(id).await?;
            Ok(!unlocked.is_empty() || !locked.is_empty())
        },
        SecretError::Failed("the wallet did not answer".into()),
    )
    .await
}

/// Stores the passphrase in the default collection, replacing one already
/// stored for the credential.
pub async fn store(id: &str, name: &str, passphrase: &str) -> Result<(), SecretError> {
    bounded(
        async {
            let session = Session::open().await?;
            let collection: OwnedObjectPath = call(&session.conn, SERVICE_PATH, SERVICE_IFACE, "ReadAlias", &("default",)).await?;
            if collection.as_str() == "/" {
                return Err(SecretError::Failed("The wallet has no default collection.".into()));
            }
            let locked: OwnedValue = call(&session.conn, collection.as_str(), PROPERTIES_IFACE, "Get", &(COLLECTION_IFACE, "Locked")).await?;
            if bool::try_from(locked).unwrap_or(true) {
                session.unlock(std::slice::from_ref(&collection)).await?;
            }
            let schema = format!("{APP_ID}.passphrase");
            let mut attrs = attributes(id);
            attrs.insert("xdg:schema", &schema);
            let properties: HashMap<&str, Value> = HashMap::from([
                ("org.freedesktop.Secret.Item.Label", Value::from(format!("Agentic Workspace — SSH key {name}"))),
                ("org.freedesktop.Secret.Item.Attributes", Value::from(attrs)),
            ]);
            let secret: Wire = (session.path.clone(), Vec::new(), passphrase.as_bytes().to_vec(), "text/plain".into());
            let (_, prompt): (OwnedObjectPath, OwnedObjectPath) =
                call(&session.conn, collection.as_str(), COLLECTION_IFACE, "CreateItem", &(properties, secret, true)).await?;
            session.prompt(&prompt).await
        },
        SecretError::StayedLocked,
    )
    .await
}

/// The stored passphrase, unlocking the wallet if it has to; `None` when
/// nothing is stored for the credential.
pub async fn lookup(id: &str) -> Result<Option<String>, SecretError> {
    bounded(
        async {
            let session = Session::open().await?;
            let (unlocked, locked) = session.search(id).await?;
            let item = match (unlocked.first(), locked.first()) {
                (Some(item), _) => item.clone(),
                (None, Some(item)) => {
                    session.unlock(std::slice::from_ref(item)).await?;
                    item.clone()
                }
                (None, None) => return Ok(None),
            };
            let (_, _, value, _): Wire = call(&session.conn, item.as_str(), ITEM_IFACE, "GetSecret", &(session.path.as_ref(),)).await?;
            String::from_utf8(value).map(Some).map_err(|_| failed("the stored passphrase is not text"))
        },
        SecretError::StayedLocked,
    )
    .await
}

/// Deletes every item stored for the credential, unlocking first: a locked
/// item cannot be deleted. Nothing stored is not an error.
pub async fn delete(id: &str) -> Result<(), SecretError> {
    bounded(
        async {
            let session = Session::open().await?;
            let (unlocked, locked) = session.search(id).await?;
            if !locked.is_empty() {
                session.unlock(&locked).await?;
            }
            for item in unlocked.iter().chain(locked.iter()) {
                let prompt: OwnedObjectPath = call(&session.conn, item.as_str(), ITEM_IFACE, "Delete", &()).await?;
                session.prompt(&prompt).await?;
            }
            Ok(())
        },
        SecretError::StayedLocked,
    )
    .await
}
