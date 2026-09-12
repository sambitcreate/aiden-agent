use crate::{
    inventory::{self, Inventory, Result},
    trusted_path as fs,
};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Write},
    os::unix::fs::MetadataExt,
};

pub struct Request<'a> {
    pub store: &'a str,
    pub source: &'a str,
    pub inventory: &'a str,
    pub approval: &'a str,
}
fn external(left: &str, right: &str) -> bool {
    left != right && !right.starts_with(&format!("{}/", left.trim_end_matches('/')))
}
fn trusted_input(path: &str, maximum: usize) -> Result<Vec<u8>> {
    let (parent, base) = path.rsplit_once('/').ok_or("absolute input required")?;
    if base.is_empty() || base == "." || base == ".." {
        return Err("invalid input basename".into());
    }
    let parent = fs::absolute(if parent.is_empty() { "/" } else { parent }, true)?;
    let mut file = fs::read_at(&parent, base)?;
    fs::protected(&file, false)?;
    fs::payload_metadata(&file)?;
    let before = file.metadata()?;
    if before.len() > maximum as u64 {
        return Err("input exceeds byte bound".into());
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(maximum as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > maximum
        || !same(&before, &file.metadata()?)
        || bytes.len() as u64 != before.len()
    {
        return Err("input changed during read".into());
    }
    Ok(bytes)
}
pub(crate) fn same(a: &std::fs::Metadata, b: &std::fs::Metadata) -> bool {
    a.dev() == b.dev()
        && a.ino() == b.ino()
        && a.mode() == b.mode()
        && a.nlink() == b.nlink()
        && a.uid() == b.uid()
        && a.gid() == b.gid()
        && a.len() == b.len()
        && a.mtime() == b.mtime()
        && a.mtime_nsec() == b.mtime_nsec()
        && a.ctime() == b.ctime()
        && a.ctime_nsec() == b.ctime_nsec()
}
fn safe_modes(inventory: &Inventory) -> Result<()> {
    for entry in &inventory.entries {
        // First staging profile deliberately excludes setuid/setgid/sticky and
        // writable-by-others payloads. No chrome-sandbox privilege exception.
        if entry.mode & !0o755 != 0
            || entry.mode & 0o400 == 0
            || (entry.kind == "directory" && entry.mode & 0o100 == 0)
        {
            return Err("unsupported or unsafe staging mode".into());
        }
    }
    Ok(())
}
fn file_hash(
    mut file: &File,
    expected_size: u64,
    mut destination: Option<&mut File>,
) -> Result<String> {
    let before = file.metadata()?;
    if !before.is_file() || before.nlink() != 1 || before.len() != expected_size {
        return Err("unexpected regular file/size/link count".into());
    }
    let mut total = 0u64;
    let mut hash = Sha256::new();
    let mut bytes = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        total += n as u64;
        if total > expected_size {
            return Err("source grew during copy".into());
        }
        hash.update(&bytes[..n]);
        if let Some(output) = destination.as_mut() {
            output.write_all(&bytes[..n])?;
        }
    }
    if total != expected_size || !same(&before, &file.metadata()?) {
        return Err("file changed during copy/hash".into());
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn walk(root: &File) -> Result<Vec<String>> {
    fn visit(root: &File, current: &str, results: &mut Vec<String>, depth: usize) -> Result<()> {
        if depth > 64 || results.len() >= inventory::ENTRIES {
            return Err("tree bounds exceeded".into());
        }
        results.push(current.to_owned());
        let object = fs::read_at(root, current)?;
        let before = object.metadata()?;
        if before.is_dir() {
            for child in fs::children(&object)? {
                let name = if current == "." {
                    child
                } else {
                    format!("{current}/{child}")
                };
                if !inventory::relative(&name, false) {
                    return Err("invalid filesystem path".into());
                }
                visit(root, &name, results, depth + 1)?;
            }
            if !same(&before, &object.metadata()?) {
                return Err("directory changed during traversal".into());
            }
        } else if !before.is_file() || before.nlink() != 1 {
            return Err("unsupported tree entry".into());
        }
        Ok(())
    }
    let mut paths = Vec::new();
    visit(root, ".", &mut paths, 0)?;
    paths[1..].sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(paths)
}
fn verify_tree(root: &File, inventory: &Inventory, expected_context: Option<&[u8]>) -> Result<()> {
    let actual = walk(root)?;
    if actual
        != inventory
            .entries
            .iter()
            .map(|e| e.path.clone())
            .collect::<Vec<_>>()
    {
        return Err("tree entries differ from inventory".into());
    }
    for entry in &inventory.entries {
        let file = fs::read_at(root, &entry.path)?;
        let meta = file.metadata()?;
        if meta.mode() & 0o7777 != entry.mode || meta.is_dir() != (entry.kind == "directory") {
            return Err("tree mode/type mismatch".into());
        }
        let context = fs::payload_metadata(&file)?;
        if let Some(expected) = expected_context {
            fs::protected(&file, entry.kind == "directory")?;
            if context != expected {
                return Err(format!(
                    "unexpected destination staging context at {:?}: expected {:?}, actual {:?}",
                    entry.path,
                    String::from_utf8_lossy(expected),
                    String::from_utf8_lossy(&context)
                )
                .into());
            }
        }
        if entry.kind == "file"
            && file_hash(&file, entry.size.unwrap(), None)? != *entry.sha256.as_ref().unwrap()
        {
            return Err("tree content digest mismatch".into());
        }
    }
    Ok(())
}
fn write_record(generation: &File, name: &str, bytes: &[u8], context: &[u8]) -> Result<()> {
    let mut file = fs::open_at(
        generation,
        name,
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
        true,
    )?;
    file.write_all(bytes)?;
    fs::chmod(&file, 0o400)?;
    fs::protected(&file, false)?;
    if fs::payload_metadata(&file)? != context {
        return Err("unexpected record context".into());
    }
    file.sync_all()?;
    Ok(())
}
/// Stage an operator-approved local generation. Caller must be trusted root in
/// the host mount/user namespace. Host root, kernel and concurrent root writers
/// remain trusted; this does not implement production provenance or admission.
pub fn stage(request: &Request<'_>) -> Result<serde_json::Value> {
    stage_inner(request, |_| Ok(()))
}

fn stage_inner(
    request: &Request<'_>,
    checkpoint: impl Fn(&str) -> Result<()>,
) -> Result<serde_json::Value> {
    if unsafe { libc::getuid() } != 0
        || unsafe { libc::geteuid() } != 0
        || unsafe { libc::getgid() } != 0
        || unsafe { libc::getegid() } != 0
    {
        return Err("trusted host root execution required".into());
    }
    if std::fs::read_to_string("/sys/fs/selinux/enforce")?.trim() != "1" {
        return Err("SELinux enforcing required for staging metadata profile".into());
    }
    for other in [request.store, request.inventory, request.approval] {
        if !external(request.source, other) {
            return Err("store/inputs must be external to source".into());
        }
    }
    if !external(request.store, request.source)
        || !external(request.store, request.inventory)
        || !external(request.store, request.approval)
    {
        return Err("source/inputs must be external to generation store".into());
    }
    let store = fs::absolute(request.store, true)?;
    if store.metadata()?.mode() & 0o7777 != 0o700 {
        return Err("store must be mode 0700".into());
    }
    let context = fs::payload_metadata(&store)?;
    let inventory_bytes = trusted_input(request.inventory, inventory::MANIFEST_BYTES)?;
    let approval_bytes = trusted_input(request.approval, 4096)?;
    let inventory = inventory::parse(&inventory_bytes)?;
    let approval = inventory::approval(&approval_bytes, &inventory_bytes)?;
    safe_modes(&inventory)?;
    let source = fs::absolute(request.source, false)?;
    let source_meta = source.metadata()?;
    let store_meta = store.metadata()?;
    if source_meta.dev() == store_meta.dev() && source_meta.ino() == store_meta.ino() {
        return Err("source and store alias the same directory".into());
    }
    verify_tree(&source, &inventory, None)?;
    let mut random = [0u8; 16];
    File::open("/dev/urandom")?.read_exact(&mut random)?;
    let temporary = format!(".staging-{}", inventory::hash(&random));
    let generation_name = approval.inventory_sha256.clone();
    let mut creation_context = fs::CreationContext::enter(&context)?;
    let generation = fs::mkdir(&store, &temporary)?;
    let mut published = false;
    let result = (|| {
        fs::chmod(&generation, 0o700)?;
        fs::protected(&generation, true)?;
        if fs::payload_metadata(&generation)? != context {
            return Err("unexpected generation context".into());
        }
        let payload = fs::mkdir(&generation, "payload")?;
        for entry in inventory.entries.iter().skip(1) {
            let (parent, base) = entry.path.rsplit_once('/').unwrap_or((".", &entry.path));
            let parent_fd = fs::open_at(
                &payload,
                parent,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
                true,
            )?;
            if entry.kind == "directory" {
                fs::mkdir(&parent_fd, base)?;
            } else {
                let input = fs::read_at(&source, &entry.path)?;
                if input.metadata()?.mode() & 0o7777 != entry.mode {
                    return Err("source mode changed".into());
                }
                fs::payload_metadata(&input)?;
                let mut output = fs::open_at(
                    &parent_fd,
                    base,
                    libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
                    0o600,
                    true,
                )?;
                if file_hash(&input, entry.size.unwrap(), Some(&mut output))?
                    != *entry.sha256.as_ref().unwrap()
                {
                    return Err("copied bytes differ from approved digest".into());
                }
                fs::chmod(&output, entry.mode)?;
                output.sync_all()?;
            }
        }
        checkpoint("copied")?;
        for entry in inventory
            .entries
            .iter()
            .rev()
            .filter(|e| e.kind == "directory")
        {
            let directory = fs::open_at(
                &payload,
                &entry.path,
                libc::O_RDONLY | libc::O_DIRECTORY,
                0,
                true,
            )?;
            fs::chmod(&directory, entry.mode)?;
            directory.sync_all()?;
        }
        verify_tree(&payload, &inventory, Some(&context))?;
        let receipt = serde_json::json!({"schemaVersion":1,"kind":"local-staging-only","generation":generation_name,
            "inventorySha256":approval.inventory_sha256,"packageSha256Diagnostic":approval.package_sha256,
            "entries":inventory.entries.len(),"stagingContext":String::from_utf8(context.clone())?.trim_end_matches('\0'),
            "releaseAuthenticated":false,"runtimeAdmission":false,"kernelImmutable":false});
        write_record(&generation, "inventory.json", &inventory_bytes, &context)?;
        write_record(&generation, "approval.json", &approval_bytes, &context)?;
        write_record(
            &generation,
            "receipt.json",
            &serde_json::to_vec_pretty(&receipt)?,
            &context,
        )?;
        generation.sync_all()?;
        creation_context.reset()?;
        checkpoint("before-publish")?;
        fs::publish(&store, &temporary, &generation_name)?;
        published = true;
        // A failure here means the private generation exists but durability is
        // uncertain. Never delete it or claim successful publication on error.
        store
            .sync_all()
            .map_err(|e| format!("generation published but parent fsync failed: {e}"))?;
        Ok(receipt)
    })();
    if result.is_err() && !published {
        if let Err(cleanup) =
            fs::remove_tree(&store, &temporary).and_then(|_| Ok(store.sync_all()?))
        {
            return Err(format!(
                "{}; cleanup failed for {temporary}: {cleanup}",
                result.unwrap_err()
            )
            .into());
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        os::unix::{
            fs::{symlink, PermissionsExt},
            io::AsRawFd,
        },
        path::PathBuf,
        sync::atomic::{AtomicUsize, Ordering},
    };
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    struct Fixture {
        base: PathBuf,
        store: String,
        source: String,
        inventory: String,
        approval: String,
    }
    impl Fixture {
        fn new() -> Self {
            let base = PathBuf::from(format!(
                "/var/lib/aiden-managed-payload-tests-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::SeqCst)
            ));
            std::fs::create_dir(&base).unwrap();
            std::fs::set_permissions(&base, std::fs::Permissions::from_mode(0o700)).unwrap();
            let f = Self {
                store: base.join("store").to_str().unwrap().into(),
                source: base.join("source").to_str().unwrap().into(),
                inventory: base.join("inventory.json").to_str().unwrap().into(),
                approval: base.join("approval.json").to_str().unwrap().into(),
                base,
            };
            for path in [&f.store, &f.source] {
                std::fs::create_dir(path).unwrap();
                std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).unwrap();
            }
            std::fs::write(format!("{}/app", f.source), b"approved bytes").unwrap();
            std::fs::set_permissions(
                format!("{}/app", f.source),
                std::fs::Permissions::from_mode(0o644),
            )
            .unwrap();
            f.records(0o644);
            f
        }
        fn records(&self, mode: u32) {
            let inventory = serde_json::json!({"schemaVersion":1,"hashAlgorithm":"sha256","entries":[
                {"path":".","type":"directory","mode":448},{"path":"app","type":"file","mode":mode,"size":14,"sha256":inventory::hash(b"approved bytes")}]});
            let bytes = serde_json::to_vec(&inventory).unwrap();
            std::fs::write(&self.inventory, &bytes).unwrap();
            std::fs::write(&self.approval,serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"kind":"local-staging-only","inventorySha256":inventory::hash(&bytes),"packageSha256":"a".repeat(64)})).unwrap()).unwrap();
        }
        fn request(&self) -> Request<'_> {
            Request {
                store: &self.store,
                source: &self.source,
                inventory: &self.inventory,
                approval: &self.approval,
            }
        }
        fn empty(&self) {
            assert_eq!(std::fs::read_dir(&self.store).unwrap().count(), 0);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.base).unwrap();
        }
    }
    fn attr(path: &str, key: &str, value: &[u8]) {
        let path = std::ffi::CString::new(path).unwrap();
        let key = std::ffi::CString::new(key).unwrap();
        assert_eq!(
            unsafe {
                libc::setxattr(
                    path.as_ptr(),
                    key.as_ptr(),
                    value.as_ptr().cast(),
                    value.len(),
                    0,
                )
            },
            0
        );
    }
    #[test]
    #[ignore = "explicit trusted-root Fedora SELinux integration; never invokes sudo"]
    fn root_staging_integration() {
        assert_eq!(unsafe { libc::geteuid() }, 0);
        assert_eq!(
            std::fs::read_to_string("/sys/fs/selinux/enforce")
                .unwrap()
                .trim(),
            "1"
        );
        // The initial generation mkdir must roll back even before the outer
        // staging closure exists, if its descriptor reopen fails.
        let f = Fixture::new();
        let store = fs::absolute(&f.store, true).unwrap();
        let error = fs::mkdir_reopen_failure(&store, ".staging-injected").unwrap_err();
        assert!(error
            .to_string()
            .contains("injected post-mkdir reopen failure"));
        f.empty();
        drop(f);
        // Fresh destination inode remains independent of an already-open writer.
        let f = Fixture::new();
        let held = std::fs::OpenOptions::new()
            .write(true)
            .open(format!("{}/app", f.source))
            .unwrap();
        let receipt = stage_inner(&f.request(), |point| {
            if point == "copied" {
                (&held).write_all(b"hostile change")?;
                held.sync_all()?;
            }
            Ok(())
        })
        .unwrap();
        let output = PathBuf::from(&f.store)
            .join(receipt["generation"].as_str().unwrap())
            .join("payload/app");
        assert_eq!(std::fs::read(&output).unwrap(), b"approved bytes");
        assert_ne!(
            held.metadata().unwrap().ino(),
            std::fs::metadata(&output).unwrap().ino()
        );
        assert_eq!(receipt["releaseAuthenticated"], false);
        assert_eq!(receipt["runtimeAdmission"], false);
        drop(held);
        drop(f);
        // Own O_PATH pin survives a malicious pathname replacement. A fresh
        // traversal rejects the replacement rather than following its target.
        let f = Fixture::new();
        let source = fs::absolute(&f.source, false).unwrap();
        let pin = fs::open_at(&source, "app", libc::O_PATH, 0, true).unwrap();
        std::fs::rename(format!("{}/app", f.source), f.base.join("retained")).unwrap();
        symlink("/dev/zero", format!("{}/app", f.source)).unwrap();
        let mut read = fs::read_pinned(&pin).unwrap();
        let mut bytes = Vec::new();
        read.read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"approved bytes");
        assert!(fs::read_at(&source, "app").is_err());
        drop(f);
        // A device is classified through O_PATH and never opened for I/O.
        let f = Fixture::new();
        let app = format!("{}/app", f.source);
        std::fs::remove_file(&app).unwrap();
        let name = std::ffi::CString::new(app.clone()).unwrap();
        assert_eq!(
            unsafe { libc::mknod(name.as_ptr(), libc::S_IFCHR | 0o600, libc::makedev(1, 5)) },
            0
        );
        let watch = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        assert!(watch >= 0);
        assert!(unsafe { libc::inotify_add_watch(watch, name.as_ptr(), libc::IN_OPEN) } >= 0);
        assert!(stage(&f.request()).is_err());
        let mut events = [0u8; 1024];
        assert_eq!(
            unsafe { libc::read(watch, events.as_mut_ptr().cast(), events.len()) },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::EAGAIN)
        );
        unsafe {
            libc::close(watch);
        }
        f.empty();
        drop(f);
        // Lexical ancestor overlap in either direction cannot mutate the source.
        let f = Fixture::new();
        let nested = format!("{}/nested", f.source);
        std::fs::create_dir(&nested).unwrap();
        let mut request = f.request();
        request.store = &nested;
        assert!(stage(&request).is_err());
        let nested = format!("{}/nested", f.store);
        std::fs::create_dir(&nested).unwrap();
        let mut request = f.request();
        request.source = &nested;
        assert!(stage(&request).is_err());
        drop(f);
        // Fedora filename transition for "shared" must not change the exact
        // explicitly selected staging label, including nested directories.
        let f = Fixture::new();
        std::fs::create_dir(format!("{}/nested", f.source)).unwrap();
        std::fs::create_dir(format!("{}/nested/shared", f.source)).unwrap();
        for p in ["nested", "nested/shared"] {
            std::fs::set_permissions(
                format!("{}/{p}", f.source),
                std::fs::Permissions::from_mode(0o755),
            )
            .unwrap();
        }
        let mut inventory: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&f.inventory).unwrap()).unwrap();
        for p in ["nested", "nested/shared"] {
            inventory["entries"]
                .as_array_mut()
                .unwrap()
                .push(serde_json::json!({"path":p,"type":"directory","mode":493}));
        }
        let bytes = serde_json::to_vec(&inventory).unwrap();
        std::fs::write(&f.inventory, &bytes).unwrap();
        std::fs::write(&f.approval, serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"kind":"local-staging-only","inventorySha256":inventory::hash(&bytes),"packageSha256":"a".repeat(64)})).unwrap()).unwrap();
        stage(&f.request()).unwrap();
        // A following invocation also proves the preceding guard reset, because
        // entering with any preexisting creation context is rejected.
        assert!(stage(&f.request())
            .unwrap_err()
            .to_string()
            .contains("File exists"));
        drop(f);
        // Publication never replaces existing generations.
        let f = Fixture::new();
        stage(&f.request()).unwrap();
        assert!(stage(&f.request()).is_err());
        assert_eq!(std::fs::read_dir(&f.store).unwrap().count(), 1);
        drop(f);
        // Inject failures after materializing fresh files and just before rename.
        for point in ["copied", "before-publish"] {
            let f = Fixture::new();
            assert!(stage_inner(&f.request(), |p| if p == point {
                Err("injected I/O failure".into())
            } else {
                Ok(())
            })
            .is_err());
            f.empty();
        }
        for attack in [
            "source-link",
            "source-hardlink",
            "extra",
            "bad-hash",
            "unsafe-mode",
            "setuid",
            "source-acl",
            "store-acl",
            "approval-acl",
            "xattr",
            "capability",
            "source-fifo",
            "store-mode",
            "store-owner",
            "approval-owner",
            "approval-link",
            "ancestor-link",
        ] {
            let f = Fixture::new();
            let app = format!("{}/app", f.source);
            match attack {
                "source-link" => {
                    std::fs::remove_file(&app).unwrap();
                    symlink(&f.inventory, &app).unwrap();
                }
                "source-hardlink" => std::fs::hard_link(&app, f.base.join("alias")).unwrap(),
                "extra" => std::fs::write(format!("{}/extra", f.source), b"x").unwrap(),
                "bad-hash" => std::fs::write(&app, b"modified bytes").unwrap(),
                "unsafe-mode" | "setuid" => {
                    let mode = if attack == "setuid" { 0o4755 } else { 0o666 };
                    std::fs::set_permissions(&app, std::fs::Permissions::from_mode(mode)).unwrap();
                    f.records(mode);
                }
                "source-acl" | "store-acl" | "approval-acl" => {
                    let target = if attack == "source-acl" {
                        &app
                    } else if attack == "store-acl" {
                        &f.store
                    } else {
                        &f.approval
                    };
                    assert!(std::process::Command::new("setfacl")
                        .args(["-m", "u:1000:r", target])
                        .status()
                        .unwrap()
                        .success());
                }
                "xattr" => attr(&app, "user.unexpected", b"x"),
                "capability" => {
                    let mut cap = [0u8; 20];
                    cap[..4].copy_from_slice(&0x02000001u32.to_le_bytes());
                    cap[4..8].copy_from_slice(&1u32.to_le_bytes());
                    attr(&app, "security.capability", &cap);
                }
                "source-fifo" => {
                    std::fs::remove_file(&app).unwrap();
                    let p = std::ffi::CString::new(app).unwrap();
                    assert_eq!(unsafe { libc::mkfifo(p.as_ptr(), 0o600) }, 0);
                }
                "store-mode" => {
                    std::fs::set_permissions(&f.store, std::fs::Permissions::from_mode(0o777))
                        .unwrap()
                }
                "store-owner" | "approval-owner" => {
                    let path = if attack == "store-owner" {
                        &f.store
                    } else {
                        &f.approval
                    };
                    let fd = File::open(path).unwrap();
                    assert_eq!(unsafe { libc::fchown(fd.as_raw_fd(), 1000, 0) }, 0);
                }
                "approval-link" => {
                    std::fs::remove_file(&f.approval).unwrap();
                    symlink(&f.inventory, &f.approval).unwrap();
                }
                "ancestor-link" => {
                    std::fs::rename(&f.store, f.base.join("other")).unwrap();
                    symlink(f.base.join("other"), &f.store).unwrap();
                }
                _ => unreachable!(),
            }
            assert!(stage(&f.request()).is_err(), "{attack}");
            f.empty();
        }
        assert_eq!(
            std::fs::read_to_string("/sys/fs/selinux/enforce")
                .unwrap()
                .trim(),
            "1"
        );
    }
}
