#!/usr/bin/env python3
"""Extract requested MasterGo snapshots from Chromium stream-1 cache bodies.

No network, GUI, stream-0/header reads or credential-store access. Metadata
identity comes only from documents/ID -> fileKey -> data/UUID, never text hits.
"""
from pathlib import Path
import argparse
import ctypes
from ctypes import wintypes
import datetime as dt
import gzip
import hashlib
import json
import os
import re
import struct
import sys
import urllib.parse
import zlib

try:
    import brotli
except ImportError:
    brotli = None

UUID = r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
MAX_BYTES = 512 * 1024 * 1024


def shared_read(path, offset=0, size=None):
    """Open with FILE_SHARE_READ|WRITE|DELETE; never change the cache lock."""
    if os.name != "nt":
        with path.open("rb") as stream:
            stream.seek(offset)
            return stream.read() if size is None else stream.read(size)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD, wintypes.DWORD, wintypes.HANDLE]
    kernel.CreateFileW.restype = wintypes.HANDLE
    kernel.GetFileSizeEx.argtypes = [wintypes.HANDLE, ctypes.POINTER(ctypes.c_longlong)]
    kernel.SetFilePointerEx.argtypes = [wintypes.HANDLE, ctypes.c_longlong, ctypes.c_void_p, wintypes.DWORD]
    kernel.ReadFile.argtypes = [wintypes.HANDLE, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    handle = kernel.CreateFileW(str(path), 0x80000000, 7, None, 3, 0x80, None)
    if handle == ctypes.c_void_p(-1).value:
        raise OSError("cache-open-failed")
    try:
        length = ctypes.c_longlong()
        if not kernel.GetFileSizeEx(handle, ctypes.byref(length)):
            raise OSError("cache-size-failed")
        amount = length.value - offset if size is None else size
        if amount < 0 or amount > MAX_BYTES or offset < 0 or offset + amount > length.value:
            raise ValueError("cache-range-invalid")
        if not kernel.SetFilePointerEx(handle, offset, None, 0):
            raise OSError("cache-seek-failed")
        result = ctypes.create_string_buffer(amount)
        count = wintypes.DWORD()
        if not kernel.ReadFile(handle, result, amount, ctypes.byref(count), None) or count.value != amount:
            raise OSError("cache-read-incomplete")
        return result.raw[:count.value]
    finally:
        kernel.CloseHandle(handle)


def iso_time(value):
    return dt.datetime.fromtimestamp(value).astimezone().isoformat()


def decode_body(body):
    if body.startswith(b"\x09") or body.lstrip()[:1] in (b"{", b"["):
        return body, "none"
    if body.startswith(b"\x1f\x8b"):
        return gzip.decompress(body), "gzip"
    for name, decode in [("brotli", brotli.decompress if brotli else None), ("zlib", zlib.decompress)]:
        if decode:
            try:
                return decode(body), name
            except Exception:
                pass
    return body, "unrecognized-or-uncompressed"


class CacheReader:
    def __init__(self, directory):
        self.directory = directory

    def address(self, address, size):
        if not address & 0x80000000 or not 0 < size <= MAX_BYTES:
            return None, None
        kind = (address >> 28) & 7
        if kind == 0:
            target = self.directory / ("f_%06x" % (address & 0x0fffffff))
            offset = 0
        elif kind in (2, 3, 4):
            block_size = {2: 256, 3: 1024, 4: 4096}[kind]
            if size > block_size * (((address >> 24) & 3) + 1):
                return None, None
            target = self.directory / ("data_%d" % ((address >> 16) & 255))
            offset = 8192 + (address & 65535) * block_size
        else:
            return None, None
        try:
            body = shared_read(target, offset, size)
            return (body, iso_time(target.stat().st_mtime)) if len(body) == size else (None, None)
        except (OSError, ValueError):
            return None, None

    def entries(self):
        content = shared_read(self.directory / "data_1")
        for offset in range(8192, len(content) - 255, 256):
            entry = content[offset:offset + 256]
            state, = struct.unpack_from("<i", entry, 20)
            key_len, = struct.unpack_from("<i", entry, 32)
            body_size, = struct.unpack_from("<i", entry, 44)  # stream 1 only
            body_address, = struct.unpack_from("<I", entry, 60)
            if state != 0 or not 0 < key_len < 65536 or not 0 < body_size <= MAX_BYTES or not body_address & 0x80000000:
                continue
            key_address, = struct.unpack_from("<I", entry, 36)
            if key_address:
                key, _ = self.address(key_address, key_len)
            else:
                key = entry[96:96 + key_len] if key_len <= 160 else None
            if not key or len(key) != key_len:
                continue
            start = key.find(b"https://")
            if start < 0:
                continue
            try:
                url = urllib.parse.urlsplit(key[start:].decode("utf-8"))
                if url.hostname not in ("mastergo.com", "www.mastergo.com") or url.username or url.password or url.port:
                    continue
                created, = struct.unpack_from("<q", entry, 24)
                created_at = iso_time(created / 1000000 - 11644473600) if created > 11644473600000000 else None
            except (ValueError, UnicodeError, OverflowError, OSError):
                continue
            yield {"path": url.path, "entryOffset": offset, "cacheDate": created_at,
                   "address": body_address, "size": body_size}

    def body(self, entry):
        return self.address(entry["address"], entry["size"])

    def complete_external_gzip(self, entry, prefix):
        """Recover a stale length only inside the already mapped stream-1 file."""
        if not prefix.startswith(b"\x1f\x8b") or (entry["address"] >> 28) & 7 != 0:
            return None, None
        target = self.directory / ("f_%06x" % (entry["address"] & 0x0fffffff))
        try:
            before = target.stat()
            if not entry["size"] < before.st_size <= MAX_BYTES:
                return None, None
            body = shared_read(target, 0, before.st_size)
            after = target.stat()
            if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns) or not body.startswith(prefix):
                return None, None
            # No partial deflate recovery: gzip checks every member's end, CRC
            # and ISIZE. A larger but still incomplete file remains a failure.
            decoded = gzip.decompress(body)
            return (body, decoded), iso_time(after.st_mtime)
        except (OSError, ValueError, EOFError, zlib.error):
            return None, None


def file_key(value):
    if not isinstance(value, str):
        return None
    url = urllib.parse.urlsplit(value)
    if url.netloc and (url.scheme != "https" or url.hostname not in ("mastergo.com", "www.mastergo.com") or url.username or url.password or url.port):
        return None
    match = re.fullmatch(r"(?:/?data/)?(" + UUID + r")", url.path)
    return match.group(1).lower() if match else None


def safe_identifier(value):
    text = str(value) if value is not None else ""
    return text if re.fullmatch(r"\d{1,24}", text) else None


def metadata_from(body, source_id):
    decoded, _ = decode_body(body)
    value = json.loads(decoded)
    data = value.get("data") if isinstance(value, dict) else None
    if not isinstance(data, dict) or (data.get("id") is not None and safe_identifier(data["id"]) != source_id):
        return None
    key = file_key(data.get("fileKey"))
    if not key:
        return None
    name = data.get("name")
    return {"id": source_id, "name": name if isinstance(name, str) and len(name) <= 1024 else None,
            "teamId": safe_identifier(data.get("teamId", data.get("team_id"))),
            "projectId": safe_identifier(data.get("projectId", data.get("project_id"))), "fileKey": key}


def extract(request_path, output_dir, cache_dir):
    request = json.loads(request_path.read_text(encoding="utf-8-sig"))
    items = request.get("mastergo")
    if not isinstance(items, list) or not items:
        raise ValueError("request.mastergo must contain source IDs")
    source_ids = [safe_identifier(item.get("id")) if isinstance(item, dict) else None for item in items]
    if any(value is None for value in source_ids) or len(set(source_ids)) != len(source_ids):
        raise ValueError("source IDs must be unique numeric IDs")
    output_dir.mkdir(parents=True, exist_ok=False)
    reader = CacheReader(cache_dir)
    metadata_entries = {identifier: [] for identifier in source_ids}
    data_entries = {}
    try:
        for entry in reader.entries():
            match = re.fullmatch(r"/api/v1/documents/(\d+)", entry["path"])
            if match and match.group(1) in metadata_entries:
                metadata_entries[match.group(1)].append(entry)
            match = re.fullmatch(r"/data/(" + UUID + r")", entry["path"])
            if match:
                data_entries.setdefault(match.group(1).lower(), []).append(entry)
    except (OSError, ValueError):
        pass
    documents = []
    for source_id in source_ids:
        result = {"sourceId": source_id, "sourceName": None, "status": "missing-metadata", "documentPath": None,
                  "documentSha256": None, "snapshotTime": None, "identityEvidence": None, "metadata": None}
        documents.append(result)
        candidates = []
        for entry in metadata_entries[source_id]:
            body, _ = reader.body(entry)
            if not body:
                continue
            try:
                metadata = metadata_from(body, source_id)
            except Exception:
                metadata = None
            if metadata:
                candidates.append((metadata, entry))
        unique = {json.dumps(value, sort_keys=True) for value, _ in candidates}
        if not unique:
            continue
        if len(unique) != 1:
            result["status"] = "metadata-conflict"
            continue
        metadata, meta_entry = candidates[0]
        result.update(sourceName=metadata["name"], metadata=metadata,
                      identityEvidence={"fileKey": metadata["fileKey"], "dataPath": "/data/" + metadata["fileKey"],
                                        "metadataPath": "/api/v1/documents/" + source_id, "metadataEntryOffset": meta_entry["entryOffset"]})
        bodies = []
        failures = []
        diagnostics = []
        for entry in data_entries.get(metadata["fileKey"], []):
            body, modified_at = reader.body(entry)
            if not body:
                failures.append("incomplete-document")
                diagnostics.append({"code": "DOCUMENT_BODY_UNREADABLE", "dataEntryOffset": entry["entryOffset"],
                                    "declaredBodyBytes": entry["size"]})
                continue
            try:
                decoded, compression = decode_body(body)
            except Exception as error:
                recovered, recovered_at = reader.complete_external_gzip(entry, body)
                if recovered is None:
                    incomplete = isinstance(error, EOFError)
                    failures.append("incomplete-document" if incomplete else "invalid-document")
                    diagnostics.append({"code": "GZIP_INCOMPLETE" if incomplete else "DOCUMENT_DECODE_FAILED",
                                        "dataEntryOffset": entry["entryOffset"], "declaredBodyBytes": entry["size"]})
                    continue
                body, decoded = recovered
                modified_at, compression = recovered_at, "gzip"
                diagnostics.append({"code": "EXTERNAL_GZIP_LENGTH_RECOVERED", "dataEntryOffset": entry["entryOffset"],
                                    "declaredBodyBytes": entry["size"], "cachedBodyBytes": len(body)})
            bodies.append((hashlib.sha256(decoded).hexdigest(), decoded, body, compression, entry, modified_at))
        if diagnostics:
            result["cacheDiagnostics"] = diagnostics
        if failures:
            # An in-flight or damaged duplicate cannot silently select an older
            # valid body whose relationship to this candidate is unknown.
            result["status"] = "incomplete-document" if "incomplete-document" in failures else "invalid-document"
            continue
        if not bodies:
            result["status"] = "missing-document"
            continue
        if len({item[0] for item in bodies}) != 1:
            result["status"] = "document-conflict"
            continue
        digest, decoded, body, compression, entry, modified_at = bodies[0]
        folder = output_dir / source_id
        folder.mkdir()
        body_path, document_path = folder / "document.body", folder / "document"
        with body_path.open("xb") as stream:
            stream.write(body)
        with document_path.open("xb") as stream:
            stream.write(decoded)
        result.update(status="extracted", documentPath=str(document_path.resolve()), documentSha256=digest,
                      snapshotTime=entry["cacheDate"] or modified_at, cachedBodyPath=str(body_path.resolve()),
                      cachedBodySha256=hashlib.sha256(body).hexdigest(), compression=compression,
                      cachedBodyBytes=len(body), documentBytes=len(decoded), cacheContainerMtime=modified_at,
                      metadataSnapshotTime=meta_entry["cacheDate"], documentFormatHint="native-binary-candidate" if decoded.startswith(b"\x09") else "unrecognized")
        result["identityEvidence"]["dataEntryOffset"] = entry["entryOffset"]
    report = {"teamName": request.get("teamName"), "documents": documents, "examinedAt": dt.datetime.now().astimezone().isoformat(),
              "cloudFreshnessVerified": False, "readPolicy": "requested document metadata and mapped data bodies, stream 1 only; no headers, credentials, network or GUI"}
    with (output_dir / "report.json").open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)
        stream.write("\n")
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("request", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--cache-dir", type=Path, default=Path(os.environ.get("APPDATA", "")) / "master-desktop/Cache/Cache_Data")
    args = parser.parse_args()
    try:
        report = extract(args.request, args.output_dir, args.cache_dir)
    except FileExistsError:
        print("Output already exists; refusing to overwrite.", file=sys.stderr)
        return 2
    except Exception:
        print("Cache extraction failed; input/output was not overwritten.", file=sys.stderr)
        return 1
    print(json.dumps({"documents": [{"sourceId": item["sourceId"], "status": item["status"]} for item in report["documents"]]}, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
