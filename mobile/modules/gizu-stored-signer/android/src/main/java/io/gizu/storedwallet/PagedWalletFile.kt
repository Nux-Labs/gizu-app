package io.gizu.storedwallet

import java.security.MessageDigest
import org.json.JSONArray
import org.json.JSONObject

/**
 * Immutable ciphertext pages are committed before the atomic root pointer. Legacy files remain
 * readable.
 */
internal class PagedWalletFile(
  private val root: WalletFile,
  private val page: (String) -> WalletFile,
  private val maxBytes: Int = 16 * 1024 * 1024,
  private val prune: (Set<String>) -> Unit = {},
) : WalletFile {
  companion object {
    const val PAGE_BYTES = 64 * 1024
  }

  private val magic = "GIZU-PAGES-1\n".toByteArray()

  private fun hash(value: ByteArray) =
    MessageDigest.getInstance("SHA-256").digest(value).joinToString("") { "%02x".format(it) }

  override fun exists() = root.exists()

  override fun read(): ByteArray {
    val bytes = root.read()
    if (!bytes.take(magic.size).toByteArray().contentEquals(magic)) return bytes
    val index = JSONObject(String(bytes, magic.size, bytes.size - magic.size, Charsets.UTF_8))
    val size = index.getInt("size")
    require(size in 1..maxBytes)
    val pages = index.getJSONArray("pages")
    require(pages.length() == (size + PAGE_BYTES - 1) / PAGE_BYTES)
    val result = ByteArray(size)
    for (i in 0 until pages.length()) {
      val id = pages.getString(i)
      require(id.matches(Regex("[0-9a-f]{64}")))
      val chunk = page(id).read()
      require(chunk.size == minOf(PAGE_BYTES, size - i * PAGE_BYTES) && hash(chunk) == id)
      chunk.copyInto(result, i * PAGE_BYTES)
    }
    return result
  }

  private fun committedPages(): Set<String> {
    if (!root.exists()) return emptySet()
    val bytes = root.read()
    if (!bytes.take(magic.size).toByteArray().contentEquals(magic)) return emptySet()
    val ids =
      JSONObject(String(bytes, magic.size, bytes.size - magic.size, Charsets.UTF_8))
        .getJSONArray("pages")
    return (0 until ids.length()).map { ids.getString(it) }.toSet()
  }

  override fun write(bytes: ByteArray) {
    val previous = committedPages()
    // A failed root commit can strand a full attempted snapshot. Reclaim it before allocating
    // again.
    // Android serializes this complete read/prune/stage/commit sequence by canonical file path.
    prune(previous)
    require(bytes.size in 1..maxBytes)
    if (bytes.size <= PAGE_BYTES) {
      root.write(bytes)
      prune(previous)
      return
    }
    val ids = JSONArray()
    for (offset in bytes.indices step PAGE_BYTES) {
      val chunk = bytes.copyOfRange(offset, minOf(bytes.size, offset + PAGE_BYTES))
      val id = hash(chunk)
      val target = page(id)
      if (!target.exists()) target.write(chunk)
      check(target.read().contentEquals(chunk))
      ids.put(id)
    }
    root.write(
      magic + JSONObject().put("size", bytes.size).put("pages", ids).toString().toByteArray()
    )
    prune(previous + (0 until ids.length()).map { ids.getString(it) })
  }
}

/**
 * Admission counts pending work, never total lifetime rows. Signed uncertainty is never terminal.
 */
internal fun journalEntryPending(row: JSONObject): Boolean {
  if (
    row.optBoolean("signingPending") ||
      row.optBoolean("signingAuthorizationPending") ||
      row.optBoolean("conflict")
  )
    return true
  if (row.optString("phase") in setOf("invested", "withdrawn", "completed")) return false
  if (row.has("steps")) {
    val steps = row.getJSONArray("steps")
    if (steps.length() > 0)
      return (0 until steps.length()).any {
        steps.getJSONObject(it).optString("status") !in terminalSteps
      }
  }
  if (
    row.optString("status") in
      setOf("paid", "completed", "credited", "finalized", "reverted", "nonceCancelled")
  )
    return false
  if (row.optString("status") == "expired" && !row.has("raw") && !row.has("rawTransaction"))
    return false
  val signed =
    listOf(
        "raw",
        "signedData",
        "signedUserOperation",
        "rawTransaction",
        "signedTransaction",
        "permit",
        "signedOrder",
      )
      .any(row::has)
  return signed || !(row.optBoolean("cancelled") || row.optString("status") == "cancelled")
}
