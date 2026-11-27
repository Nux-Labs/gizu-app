package io.gizu.storedwallet.swap

import java.math.BigInteger
import org.json.JSONArray
import org.json.JSONObject

/** Every child's native state is retained across progress, pauses and cancellation. */
internal class SwapFundingBatch private constructor(val json: JSONObject) {
  val pooled: Boolean
    get() = json.getInt("version") == 2

  val fundingSize: Int
    get() = json.getJSONArray("children").length()

  val executing: Boolean
    get() = pooled && currentIndex == fundingSize && json.optJSONObject("execution") != null

  val needsExecution: Boolean
    get() = pooled && !cancelled && json.optJSONObject("execution") == null && fundingComplete()

  val pending: Boolean
    get() =
      !cancelled &&
        if (pooled)
          !executing || JSONObject(current.getString("status")).optString("phase") != "COMPLETE"
        else currentIndex + 1 < size

  val currentIndex: Int
    get() = json.getInt("currentIndex")

  val current: JSONObject
    get() =
      if (executing) json.getJSONObject("execution")
      else json.getJSONArray("children").getJSONObject(currentIndex)

  val size: Int
    get() = fundingSize + if (pooled && json.optJSONObject("execution") != null) 1 else 0

  val id: String
    get() = json.getString("fundingBatchId")

  val cancelled: Boolean
    get() = json.getBoolean("cancelled")

  val budgetAtoms: String
    get() =
      if (pooled) json.getString("originalBudgetAtoms")
      else
        (0 until size)
          .fold(BigInteger.ZERO) { sum, index ->
            sum +
              json
                .getJSONArray("children")
                .getJSONObject(index)
                .optString("budgetAtoms", "0")
                .toBigInteger()
          }
          .toString()

  fun record(state: String, status: String) {
    check(state.length <= 900_000)
    val view = JSONObject(status)
    check(
      !view.has("operationId") || view.getString("operationId") == current.getString("operationId")
    )
    if (pooled && !executing && view.optString("phase") == "COMPLETE") {
      check(
        view.optString("kind") == "confidentialFunding" &&
          view.optString("completionTarget") == "confidential"
      )
      val credit = checkedAtoms(view.getString("creditedAtoms"), positive = true)
      check(credit <= checkedAtoms(current.getString("budgetAtoms"), positive = true))
      check(
        !current.has("creditedAtoms") || current.getString("creditedAtoms") == credit.toString()
      )
      current.put("creditedAtoms", credit.toString())
    }
    current.put("state", state).put("status", status)
  }

  /** Caller persists the completed child before switching, then persists the new cursor. */
  fun advanceIfComplete(): Boolean {
    if (
      cancelled ||
        JSONObject(current.getString("status")).getString("phase") != "COMPLETE" ||
        currentIndex + 1 >= (if (pooled) fundingSize else size)
    )
      return false
    json.put("currentIndex", currentIndex + 1)
    return true
  }

  private fun fundingComplete(): Boolean =
    (0 until fundingSize).all { index ->
      val child = json.getJSONArray("children").getJSONObject(index)
      child.has("creditedAtoms") &&
        JSONObject(child.getString("status")).optString("phase") == "COMPLETE"
    }

  fun credits(): JSONArray {
    check(pooled && fundingComplete()) {
      "Every source must have a durably saved confirmed private credit"
    }
    return JSONArray(
      (0 until fundingSize).map { index ->
        val child = json.getJSONArray("children").getJSONObject(index)
        JSONObject()
          .put("sourceId", child.getString("sourceId"))
          .put("operationId", child.getString("operationId"))
          .put("creditedAtoms", child.getString("creditedAtoms"))
      }
    )
  }

  fun executionPlan(): JSONObject {
    check(needsExecution) { "Confirmed funding is required before one downstream execution" }
    val approved = checkedAtoms(json.getString("approvedExistingPrivateAtoms"))
    val total =
      (0 until fundingSize).fold(approved) { sum, index ->
        sum +
          checkedAtoms(
            json.getJSONArray("children").getJSONObject(index).getString("creditedAtoms"),
            positive = true,
          )
      }
    checkedAtoms(total.toString(), positive = true)
    check(total <= checkedAtoms(budgetAtoms, positive = true))
    return JSONObject(json.getJSONObject("savedPlan").toString())
      .put("amountAtoms", total.toString())
  }

  fun attachExecution(child: JSONObject) {
    val plan = executionPlan()
    val actual = JSONObject(child.getString("state")).getJSONObject("plan")
    for (key in plan.keys()) check(actual.get(key).toString() == plan.get(key).toString())
    check(
      (0 until fundingSize).none {
        json.getJSONArray("children").getJSONObject(it).getString("operationId") ==
          child.getString("operationId")
      }
    )
    json.put("execution", child).put("currentIndex", fundingSize)
  }

  fun cancel() {
    json.put("cancelled", true)
  }

  fun publicStatus(status: JSONObject): JSONObject {
    val result = JSONObject(status.toString())
    val children = json.getJSONArray("children")
    if (pooled) {
      val credits =
        (0 until fundingSize).fold(BigInteger.ZERO) { sum, index ->
          sum + checkedAtoms(children.getJSONObject(index).optString("creditedAtoms", "0"))
        }
      result
        .put("operationId", id)
        .put("kind", "confidentialSwap")
        .put("completionTarget", "public")
        .put("budgetAtoms", budgetAtoms)
        .put("creditedAtoms", credits.toString())
        .put("approvedExistingPrivateAtoms", json.getString("approvedExistingPrivateAtoms"))
        .put(
          "fundedPrivateAtoms",
          (checkedAtoms(json.getString("approvedExistingPrivateAtoms")) + credits).toString(),
        )
        .put("privateCreditedAtoms", credits.toString())
      val principal =
        (0 until fundingSize).fold(BigInteger.ZERO) { sum, index ->
          val row = JSONObject(children.getJSONObject(index).getString("status"))
          sum + checkedAtoms(row.optString("sourceAtoms", "0"))
        }
      result.put("sourceAtoms", principal.toString())
      if (cancelled) result.put("phase", "CANCELLED")
      else if (!executing && result.optString("phase") == "COMPLETE")
        result.put("phase", "FUNDING").put("step", "privateHandoff")
      return result
    }
    fun total(field: String): String =
      (0 until children.length())
        .fold(BigInteger.ZERO) { sum, index ->
          val item = JSONObject(children.getJSONObject(index).getString("status"))
          val value = item.optString(field, "0").takeIf { it.matches(Regex("[0-9]+")) } ?: "0"
          sum + BigInteger(value)
        }
        .toString()
    for (field in listOf("sourceAtoms", "creditedAtoms", "receivedTargetAtoms")) result.put(
      field,
      total(field),
    )
    result.put("operationId", id)
    if (cancelled) result.put("phase", "CANCELLED")
    else if (result.getString("phase") == "COMPLETE" && currentIndex + 1 < size)
      result.put("phase", "FUNDING").put("step", "nextSourceReview")
    return result
  }

  companion object {
    fun archive(previous: JSONObject?, operationId: String): JSONArray {
      val history =
        previous?.optJSONArray("history")?.let { JSONArray(it.toString()) } ?: JSONArray()
      if (previous != null && previous.getString("operationId") != operationId) {
        val entry = JSONObject(previous.toString())
        entry.remove("history")
        history.put(entry)
      }
      return history
    }

    fun create(allocation: JSONObject, children: JSONArray): SwapFundingBatch {
      check(allocation.getInt("fundingBatchSize") == children.length())
      return restore(
        JSONObject()
          .put("version", 1)
          .put("fundingBatchId", allocation.getString("fundingBatchId"))
          .put("children", children)
          .put("currentIndex", 0)
          .put("cancelled", false)
      )
    }

    fun createPooled(
      allocation: JSONObject,
      children: JSONArray,
      manifest: JSONObject,
    ): SwapFundingBatch {
      check(allocation.getInt("fundingBatchSize") == children.length())
      return restore(
        JSONObject(manifest.toString())
          .put("version", 2)
          .put("fundingBatchId", allocation.getString("fundingBatchId"))
          .put("children", children)
          .put("currentIndex", 0)
          .put("cancelled", false)
      )
    }

    private fun checkedAtoms(value: String, positive: Boolean = false): BigInteger {
      check(value.matches(Regex(if (positive) "[1-9][0-9]{0,19}" else "0|[1-9][0-9]{0,19}")))
      return value.toBigInteger().also { check(it <= BigInteger("18446744073709551615")) }
    }

    fun restore(json: JSONObject): SwapFundingBatch {
      check(json.getInt("version") in 1..2)
      if (json.getInt("version") == 2) return restorePooled(json)
      check(json.getString("fundingBatchId").matches(Regex("[A-Za-z0-9_-]{1,128}")))
      val children = json.getJSONArray("children")
      check(children.length() in 1..256 && json.getInt("currentIndex") in 0 until children.length())
      val ids = mutableSetOf<String>()
      val indices = mutableSetOf<Int>()
      for (index in 0 until children.length()) {
        val child = children.getJSONObject(index)
        check(ids.add(child.getString("operationId")))
        val source = child.getInt("sourceIndex")
        check(source >= 0 && source != 2 && indices.add(source))
        check(child.getString("state").length <= 900_000)
        if (index < json.getInt("currentIndex"))
          check(JSONObject(child.getString("status")).getString("phase") == "COMPLETE")
      }
      return SwapFundingBatch(json)
    }

    private fun restorePooled(json: JSONObject): SwapFundingBatch {
      check(json.getString("fundingBatchId").matches(Regex("[A-Za-z0-9_-]{1,128}")))
      check(json.getString("walletId").isNotBlank() && json.getString("generation").isNotBlank())
      check(json.getString("confidentialAccount").matches(Regex("0x[0-9a-fA-F]{40}")))
      check(
        json.getString("privateAsset") == "nep245:v2_1.omni.hot.tg:143_2dmLwYWkCQKyTjeUPAsGJuiVLbFx"
      )
      val budget = checkedAtoms(json.getString("originalBudgetAtoms"), positive = true)
      val approved = checkedAtoms(json.getString("approvedExistingPrivateAtoms"))
      val children = json.getJSONArray("children")
      val execution = json.optJSONObject("execution")
      check(children.length() in 0..256)
      check(
        json.getInt("currentIndex") in
          0..if (execution != null) children.length() else maxOf(0, children.length() - 1)
      )
      val plan = json.getJSONObject("savedPlan")
      check(
        plan.getString("kind") == "confidentialPayout" &&
          SwapChains.of(plan.getLong("chainId")) != null
      )
      val recipients = plan.getJSONArray("recipientIndices")
      val indices = (0 until recipients.length()).map { recipients.getInt(it) }
      check(
        indices.size in 1..5 &&
          indices.distinct().size == indices.size &&
          indices.all { it in 3..8191 }
      )
      var gross = approved
      var credited = approved
      val ids = mutableSetOf<String>()
      val sources = mutableSetOf<String>()
      for (index in 0 until children.length()) {
        val child = children.getJSONObject(index)
        check(ids.add(child.getString("operationId")))
        val chain = child.getInt("sourceChainId")
        val token =
          when (chain) {
            143 -> "0x754704bc059f8c67012fed69bc8a327a5aafb603"
            8453 -> "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
            42161 -> "0xaf88d065e77c8cc2239327c5edb3a432268e5831"
            else -> error("Unsupported source")
          }
        check(child.getString("token").equals(token, true))
        val source = child.getInt("sourceIndex")
        check(source >= 0 && source != 2 && (chain == 143 || source == 1))
        val owner = child.getString("fundingAddress").lowercase()
        check(owner.matches(Regex("0x[0-9a-f]{40}")))
        check(sources.add("$chain:$token:$owner"))
        check(child.getString("sourceId").isNotBlank())
        gross += checkedAtoms(child.getString("budgetAtoms"), positive = true)
        check(child.getString("state").length <= 900_000)
        if (index < json.getInt("currentIndex") || child.has("creditedAtoms")) {
          val status = JSONObject(child.getString("status"))
          check(
            status.getString("phase") == "COMPLETE" &&
              status.getString("kind") == "confidentialFunding" &&
              status.getString("completionTarget") == "confidential"
          )
          check(
            checkedAtoms(child.getString("creditedAtoms"), positive = true) <=
              checkedAtoms(child.getString("budgetAtoms"), positive = true)
          )
          check(status.getString("creditedAtoms") == child.getString("creditedAtoms"))
          credited += checkedAtoms(child.getString("creditedAtoms"), positive = true)
        }
      }
      check(gross == budget)
      if (execution != null) {
        check(ids.add(execution.getString("operationId")))
        check((0 until children.length()).all { children.getJSONObject(it).has("creditedAtoms") })
        check(execution.getString("state").length <= 900_000)
        val executedPlan = JSONObject(execution.getString("state")).getJSONObject("plan")
        check(executedPlan.getString("amountAtoms") == credited.toString())
        for (key in plan.keys()) check(executedPlan.get(key).toString() == plan.get(key).toString())
      }
      return SwapFundingBatch(json)
    }
  }
}
