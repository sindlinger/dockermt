#!/usr/bin/env bash
set -euo pipefail

IMAGE_REF="${1:-sindlinger/dockermt:v3.0.3}"
OUT_DIR="${2:-artifacts}"

mkdir -p "$OUT_DIR"

safe_tag="$(echo "$IMAGE_REF" | tr '/:@' '___')"
tar_path="${OUT_DIR}/${safe_tag}.tar"
sha_path="${tar_path}.sha256"
meta_path="${OUT_DIR}/${safe_tag}.meta.txt"

echo "[dockermt] Exporting image: ${IMAGE_REF}"
echo "[dockermt] Output tar: ${tar_path}"

docker save -o "$tar_path" "$IMAGE_REF"
sha256sum "$tar_path" > "$sha_path"

{
  echo "image=${IMAGE_REF}"
  echo "created_utc=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "tar_file=$(basename "$tar_path")"
  echo "tar_sha256=$(awk '{print $1}' "$sha_path")"
  echo "docker_image_id=$(docker image inspect "$IMAGE_REF" --format '{{.Id}}')"
  echo "docker_repo_digests=$(docker image inspect "$IMAGE_REF" --format '{{range $i, $d := .RepoDigests}}{{if $i}},{{end}}{{$d}}{{end}}')"
} > "$meta_path"

echo "[dockermt] Done."
echo "[dockermt] Metadata: ${meta_path}"
echo "[dockermt] Checksum: ${sha_path}"
