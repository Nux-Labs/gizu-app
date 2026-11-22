// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StrategyRegistry} from "../src/StrategyRegistry.sol";

contract StrategyRegistryTest is Test {
    uint256 private constant SECP256K1_N =
        0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    uint256 private constant START = 1_900_000_000;

    string private json;
    StrategyRegistry private registry;
    uint256 private signerKey;
    address private signer;

    bytes32[] private assetIds;
    uint16[] private weights;
    bytes32 private salt;
    bytes32 private commitment;
    uint32 private embargo;
    bytes32 private metadataHash;
    uint64 private deadline;

    function setUp() public {
        json =
            vm.readFile(string.concat(vm.projectRoot(), "/../shared/strategy-commit-vectors.json"));
        vm.chainId(vm.parseJsonUint(json, ".domain.chainId"));
        vm.warp(START);
        address at = vm.parseJsonAddress(json, ".domain.verifyingContract");
        deployCodeTo("StrategyRegistry.sol:StrategyRegistry", at);
        registry = StrategyRegistry(at);

        signerKey = vm.deriveKey(vm.parseJsonString(json, ".mnemonic"), "m/44'/60'/146'/8453'/", 0);
        signer = vm.addr(signerKey);

        for (uint256 i; i < 4; ++i) {
            string memory p = string.concat(".basket.assets[", vm.toString(i), "]");
            assetIds.push(vm.parseJsonBytes32(json, string.concat(p, ".assetId")));
            weights.push(uint16(vm.parseJsonUint(json, string.concat(p, ".weightBps"))));
        }
        salt = vm.parseJsonBytes32(json, ".basket.salt");
        commitment = vm.parseJsonBytes32(json, ".basket.commitment");
        embargo = uint32(vm.parseJsonUint(json, ".create.embargo"));
        metadataHash = vm.parseJsonBytes32(json, ".create.metadataHash");
        deadline = uint64(vm.parseJsonUint(json, ".create.deadline"));
    }

    // --- Shared vectors -------------------------------------------------------------------

    function test_vectorSignersMatchStrategyBranch() public view {
        string memory m = vm.parseJsonString(json, ".mnemonic");
        for (uint256 i; i < 3; ++i) {
            string memory p = string.concat(".signers[", vm.toString(i), "]");
            uint256 chain = vm.parseJsonUint(json, string.concat(p, ".chainId"));
            uint32 index = uint32(vm.parseJsonUint(json, string.concat(p, ".index")));
            string memory prefix = string.concat("m/44'/60'/146'/", vm.toString(chain), "'/");
            assertEq(
                vm.addr(vm.deriveKey(m, prefix, index)),
                vm.parseJsonAddress(json, string.concat(p, ".address"))
            );
        }
    }

    function test_vectorAssetIds() public view {
        for (uint256 i; i < 4; ++i) {
            string memory p = string.concat(".basket.assets[", vm.toString(i), "]");
            bytes32 id = registry.assetIdOf(
                uint64(vm.parseJsonUint(json, string.concat(p, ".chainId"))),
                uint8(vm.parseJsonUint(json, string.concat(p, ".kind"))),
                vm.parseJsonAddress(json, string.concat(p, ".address"))
            );
            assertEq(id, assetIds[i]);
        }
    }

    function test_vectorCommitment() public view {
        assertEq(registry.commitmentOf(1, 0, assetIds, weights, salt), commitment);
    }

    function test_vectorDomainAndDigests() public view {
        assertEq(registry.domainSeparator(), vm.parseJsonBytes32(json, ".domain.separator"));
        assertEq(
            _createDigest(embargo, metadataHash, deadline),
            vm.parseJsonBytes32(json, ".create.digest")
        );
        assertEq(
            _commitDigest(1, 0, commitment, uint64(vm.parseJsonUint(json, ".commit.deadline"))),
            vm.parseJsonBytes32(json, ".commit.digest")
        );
    }

    // --- Happy path ------------------------------------------------------------------------

    function test_createCommitRevealLifecycle() public {
        uint256 id = _create();
        assertEq(id, 1);
        assertEq(registry.strategyOf(signer), 1);
        StrategyRegistry.Strategy memory s = registry.strategy(id);
        assertEq(s.signer, signer);
        assertEq(s.embargo, embargo);
        assertEq(s.metadataHash, metadataHash);

        vm.expectEmit(address(registry));
        emit StrategyRegistry.Committed(id, 0, commitment);
        uint64 seq = _commit(id, commitment);
        assertEq(seq, 0);
        assertEq(registry.commitAt(id, 0).committedAt, START);
        assertFalse(registry.isBroken(id));

        vm.warp(START + embargo);
        vm.expectEmit(address(registry));
        emit StrategyRegistry.Revealed(id, 0, assetIds, weights, salt);
        // Anyone may reveal once the embargo is over.
        vm.prank(makeAddr("anyone"));
        assertEq(registry.reveal(id, assetIds, weights, salt), 0);
        assertEq(registry.strategy(id).nextRevealSeq, 1);
        assertFalse(registry.isBroken(id));
    }

    function test_revealsFollowCommitOrder() public {
        uint256 id = _create();
        _commit(id, commitment);
        bytes32 second = registry.commitmentOf(id, 1, assetIds, weights, salt);
        _commit(id, second);

        vm.warp(START + embargo);
        // Revealing the second preimage first fails: seq 0 must be revealed before seq 1.
        vm.expectRevert(StrategyRegistry.CommitmentMismatch.selector);
        registry.reveal(id, assetIds, weights, bytes32(uint256(salt) + 1));
        assertEq(registry.reveal(id, assetIds, weights, salt), 0);
        assertEq(registry.reveal(id, assetIds, weights, salt), 1);
        vm.expectRevert(StrategyRegistry.NothingToReveal.selector);
        registry.reveal(id, assetIds, weights, salt);
    }

    function test_isBrokenAfterEmbargoAndGrace() public {
        uint256 id = _create();
        _commit(id, commitment);
        vm.warp(START + embargo + registry.REVEAL_GRACE());
        assertFalse(registry.isBroken(id));
        vm.warp(START + embargo + registry.REVEAL_GRACE() + 1);
        assertTrue(registry.isBroken(id));
        registry.reveal(id, assetIds, weights, salt);
        assertFalse(registry.isBroken(id));
    }

    // --- Create ----------------------------------------------------------------------------

    function test_createRejectsEmbargoBounds() public {
        bytes memory sig = _sign(signerKey, _createDigest(0, metadataHash, deadline));
        vm.expectRevert(StrategyRegistry.InvalidEmbargo.selector);
        registry.create(signer, 0, metadataHash, deadline, sig);

        uint32 tooLong = registry.MAX_EMBARGO() + 1;
        sig = _sign(signerKey, _createDigest(tooLong, metadataHash, deadline));
        vm.expectRevert(StrategyRegistry.InvalidEmbargo.selector);
        registry.create(signer, tooLong, metadataHash, deadline, sig);
    }

    function test_createRejectsExpiredSignature() public {
        bytes memory sig = _sign(signerKey, _createDigest(embargo, metadataHash, deadline));
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(StrategyRegistry.Expired.selector);
        registry.create(signer, embargo, metadataHash, deadline, sig);
    }

    function test_createRejectsOtherSignerAndChangedMetadata() public {
        (address other, uint256 otherKey) = makeAddrAndKey("other");
        bytes memory sig = _sign(otherKey, _createDigest(embargo, metadataHash, deadline));
        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.create(signer, embargo, metadataHash, deadline, sig);

        sig = _sign(signerKey, _createDigest(embargo, metadataHash, deadline));
        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.create(signer, embargo, keccak256("changed"), deadline, sig);
        assertEq(registry.strategyOf(other), 0);
    }

    function test_createRejectsSignerReuse() public {
        _create();
        bytes memory sig = _sign(signerKey, _createDigest(embargo, metadataHash, deadline));
        vm.expectRevert(StrategyRegistry.SignerAlreadyUsed.selector);
        registry.create(signer, embargo, metadataHash, deadline, sig);
    }

    function test_createRejectsMalformedSignatures() public {
        bytes32 digest = _createDigest(embargo, metadataHash, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);

        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.create(signer, embargo, metadataHash, deadline, abi.encodePacked(r, s));

        // The malleable twin (n - s, flipped v) recovers the same address but is rejected.
        bytes32 highS = bytes32(SECP256K1_N - uint256(s));
        uint8 flipped = v == 27 ? 28 : 27;
        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.create(
            signer, embargo, metadataHash, deadline, abi.encodePacked(r, highS, flipped)
        );

        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.create(signer, embargo, metadataHash, deadline, abi.encodePacked(r, s, uint8(1)));
    }

    function test_signatureForAnotherChainIsRejected() public {
        bytes memory sig = _sign(signerKey, _createDigest(embargo, metadataHash, deadline));
        vm.chainId(84532);
        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.create(signer, embargo, metadataHash, deadline, sig);
    }

    // --- Commit ----------------------------------------------------------------------------

    function test_commitRejectsUnknownStrategy() public {
        bytes memory sig = _sign(signerKey, _commitDigest(7, 0, commitment, deadline));
        vm.expectRevert(StrategyRegistry.UnknownStrategy.selector);
        registry.commit(7, commitment, deadline, sig);
    }

    function test_commitRejectsOtherKeyAndExpiry() public {
        uint256 id = _create();
        (, uint256 otherKey) = makeAddrAndKey("other");
        bytes memory sig = _sign(otherKey, _commitDigest(id, 0, commitment, deadline));
        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.commit(id, commitment, deadline, sig);

        sig = _sign(signerKey, _commitDigest(id, 0, commitment, deadline));
        vm.warp(uint256(deadline) + 1);
        vm.expectRevert(StrategyRegistry.Expired.selector);
        registry.commit(id, commitment, deadline, sig);
    }

    function test_commitSignatureCannotBeReplayedForTheNextSeq() public {
        uint256 id = _create();
        bytes memory sig = _sign(signerKey, _commitDigest(id, 0, commitment, deadline));
        registry.commit(id, commitment, deadline, sig);
        vm.expectRevert(StrategyRegistry.InvalidSignature.selector);
        registry.commit(id, commitment, deadline, sig);
    }

    // --- Reveal ----------------------------------------------------------------------------

    function test_revealRejectsBeforeEmbargo() public {
        uint256 id = _create();
        _commit(id, commitment);
        vm.warp(START + embargo - 1);
        vm.expectRevert(StrategyRegistry.EmbargoActive.selector);
        registry.reveal(id, assetIds, weights, salt);
    }

    function test_revealRejectsWrongPreimage() public {
        uint256 id = _create();
        _commit(id, commitment);
        vm.warp(START + embargo);
        vm.expectRevert(StrategyRegistry.CommitmentMismatch.selector);
        registry.reveal(id, assetIds, weights, keccak256("other salt"));

        uint16[] memory swapped = _copyWeights();
        (swapped[1], swapped[2]) = (swapped[2], swapped[1]);
        vm.expectRevert(StrategyRegistry.CommitmentMismatch.selector);
        registry.reveal(id, assetIds, swapped, salt);
    }

    function test_revealRejectsInvalidBaskets() public {
        uint256 id = _create();
        _commit(id, commitment);
        vm.warp(START + embargo);

        bytes32[] memory unsorted = _copyAssets();
        (unsorted[0], unsorted[1]) = (unsorted[1], unsorted[0]);
        _expectInvalidBasket(id, unsorted, weights);

        bytes32[] memory duplicate = _copyAssets();
        duplicate[1] = duplicate[0];
        _expectInvalidBasket(id, duplicate, weights);

        uint16[] memory offStep = _copyWeights();
        offStep[0] += 100;
        offStep[1] -= 100;
        _expectInvalidBasket(id, assetIds, offStep);

        uint16[] memory short = _copyWeights();
        short[0] -= 500;
        _expectInvalidBasket(id, assetIds, short);

        uint16[] memory zero = _copyWeights();
        zero[1] += zero[0];
        zero[0] = 0;
        _expectInvalidBasket(id, assetIds, zero);

        _expectInvalidBasket(id, new bytes32[](0), new uint16[](0));

        uint16[] memory three = new uint16[](3);
        _expectInvalidBasket(id, assetIds, three);

        bytes32[] memory many = new bytes32[](11);
        uint16[] memory manyWeights = new uint16[](11);
        for (uint256 i; i < 11; ++i) many[i] = bytes32(i + 1);
        _expectInvalidBasket(id, many, manyWeights);
    }

    function test_revealRejectsWhenNothingCommitted() public {
        uint256 id = _create();
        vm.expectRevert(StrategyRegistry.NothingToReveal.selector);
        registry.reveal(id, assetIds, weights, salt);
    }

    // --- Helpers ---------------------------------------------------------------------------

    function _create() private returns (uint256) {
        bytes memory sig = _sign(signerKey, _createDigest(embargo, metadataHash, deadline));
        return registry.create(signer, embargo, metadataHash, deadline, sig);
    }

    function _commit(uint256 id, bytes32 c) private returns (uint64) {
        uint64 seq = registry.strategy(id).nextSeq;
        return
            registry.commit(id, c, deadline, _sign(signerKey, _commitDigest(id, seq, c, deadline)));
    }

    function _createDigest(uint32 e, bytes32 meta, uint64 d) private view returns (bytes32) {
        return registry.hashTypedData(keccak256(abi.encode(registry.CREATE_TYPEHASH(), e, meta, d)));
    }

    function _commitDigest(uint256 id, uint64 seq, bytes32 c, uint64 d)
        private
        view
        returns (bytes32)
    {
        return registry.hashTypedData(
            keccak256(abi.encode(registry.COMMIT_TYPEHASH(), id, seq, c, d))
        );
    }

    function _sign(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _expectInvalidBasket(uint256 id, bytes32[] memory a, uint16[] memory w) private {
        vm.expectRevert(StrategyRegistry.InvalidBasket.selector);
        registry.reveal(id, a, w, salt);
    }

    function _copyAssets() private view returns (bytes32[] memory out) {
        out = new bytes32[](assetIds.length);
        for (uint256 i; i < out.length; ++i) out[i] = assetIds[i];
    }

    function _copyWeights() private view returns (uint16[] memory out) {
        out = new uint16[](weights.length);
        for (uint256 i; i < out.length; ++i) out[i] = weights[i];
    }
}
