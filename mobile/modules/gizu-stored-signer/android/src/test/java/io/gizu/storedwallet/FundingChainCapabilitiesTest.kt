package io.gizu.storedwallet

import org.junit.Assert.*
import org.junit.Test

class FundingChainCapabilitiesTest {
  @Test
  fun explicitFeatureOptInAdmitsOnlyDeclaredFundingOrigins() {
    assertEquals(
      listOf(143, 8453, 42161),
      enabledFundingChains(
        200,
        """{"fundingContractVersion":2,"fundingChainIds":[143,8453,42161]}""",
      ),
    )
    assertEquals(
      listOf(8453),
      enabledFundingChains(200, """{"fundingContractVersion":2,"fundingChainIds":[8453]}"""),
    )
  }

  @Test
  fun onlyLegacy404DefaultsToMonad() {
    assertEquals(listOf(143), enabledFundingChains(404, "not a v2 service"))
    for (status in listOf(400, 403, 500, 503)) {
      try {
        enabledFundingChains(status, "")
        fail("Unavailable service accepted")
      } catch (_: Exception) {}
    }
  }

  @Test
  fun malformedUnsupportedAndDuplicateDeclarationsNeverEnableSources() {
    for (body in
      listOf(
        "{}",
        """{"fundingContractVersion":1,"fundingChainIds":[143]}""",
        """{"fundingContractVersion":2,"fundingChainIds":[]}""",
        """{"fundingContractVersion":2,"fundingChainIds":[143,143]}""",
        """{"fundingContractVersion":2,"fundingChainIds":[1]}""",
        """{"fundingContractVersion":2,"fundingChainIds":[8453.0]}""",
      )) {
      try {
        enabledFundingChains(200, body)
        fail("Invalid sources accepted")
      } catch (_: Exception) {}
    }
  }

  @Test
  fun ethereumPrivateFundingRequiresItsExplicitQualifiedDownstreamCapability() {
    val base = """{"fundingContractVersion":2,"fundingChainIds":[143,8453,42161]}"""
    assertFalse(qualifiedEthereumPrivateFunding(200, base))
    assertFalse(qualifiedEthereumPrivateFunding(404, ""))
    assertFalse(qualifiedEthereumPrivateFunding(503, ""))
    val enabled =
      """{"fundingContractVersion":2,"fundingChainIds":[143,8453,42161],"earnPrivateFundingVersion":2,"earnPrivateFundingProfileChainIds":[1]}"""
    assertTrue(qualifiedEthereumPrivateFunding(200, enabled))
    assertFalse(qualifiedEthereumPrivateFunding(200, enabled.replace("[1]", "[4663]")))
    assertFalse(qualifiedEthereumPrivateFunding(200, enabled.replace("[1]", "[1,1]")))
    assertFalse(qualifiedEthereumPrivateFunding(200, enabled.replace("[1]", "[1.0]")))
    assertFalse(
      qualifiedEthereumPrivateFunding(
        200,
        org.json.JSONObject(enabled).put("earnPrivateFundingVersion", 1).toString(),
      )
    )
  }
}
