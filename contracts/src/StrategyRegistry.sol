// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @title Gizu Sealed Strategies registry
/// @notice Time-stamps sealed basket commitments and their later reveals. It holds no funds,
/// tokens or payments. A strategy key signs creation and every commitment (EIP-712); any relayer
/// may submit them. Anyone holding the preimage may reveal once the strategy's embargo has passed,
/// strictly in commitment order, so an unrevealed commitment is visible as a broken record.
contract StrategyRegistry {
    struct Strategy {
        address signer;
        uint32 embargo;
        uint64 nextSeq;
        uint64 nextRevealSeq;
        bytes32 metadataHash;
    }

    struct Commit {
        bytes32 commitment;
        uint64 committedAt;
    }

    uint256 public constant TOTAL_BPS = 10_000;
    uint256 public constant WEIGHT_STEP_BPS = 500;
    uint256 public constant MAX_ASSETS = 10;
    uint32 public constant MAX_EMBARGO = 30 days;
    /// @notice Extra time after an embargo before an unrevealed commitment marks the strategy broken.
    uint64 public constant REVEAL_GRACE = 1 days;

    bytes32 public constant CREATE_TYPEHASH =
        keccak256("CreateStrategy(uint32 embargo,bytes32 metadataHash,uint64 deadline)");
    bytes32 public constant COMMIT_TYPEHASH =
        keccak256("Commit(uint256 strategyId,uint64 seq,bytes32 commitment,uint64 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );
    bytes32 private constant NAME_HASH = keccak256("GizuStrategyRegistry");
    bytes32 private constant VERSION_HASH = keccak256("1");
    /// @dev secp256k1n / 2; signatures with a higher s are malleable and rejected.
    uint256 private constant MAX_S =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    uint256 private immutable cachedChainId;
    bytes32 private immutable cachedDomainSeparator;

    /// @notice Number of strategies created; ids start at 1.
    uint256 public strategyCount;
    /// @notice Strategy id created by a signer, or 0. A signer creates at most one strategy.
    mapping(address signer => uint256 id) public strategyOf;
    mapping(uint256 id => Strategy) private strategies;
    mapping(uint256 id => mapping(uint64 seq => Commit)) private commits;

    event StrategyCreated(
        uint256 indexed id, address indexed signer, uint32 embargo, bytes32 metadataHash
    );
    event Committed(uint256 indexed id, uint64 indexed seq, bytes32 commitment);
    event Revealed(
        uint256 indexed id,
        uint64 indexed seq,
        bytes32[] assetIds,
        uint16[] weightsBps,
        bytes32 salt
    );

    error InvalidEmbargo();
    error Expired();
    error InvalidSignature();
    error SignerAlreadyUsed();
    error UnknownStrategy();
    error NothingToReveal();
    error EmbargoActive();
    error InvalidBasket();
    error CommitmentMismatch();

    constructor() {
        cachedChainId = block.chainid;
        cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @notice Registers a strategy for `signer`; the signature binds the embargo and metadata.
    function create(
        address signer,
        uint32 embargo,
        bytes32 metadataHash,
        uint64 deadline,
        bytes calldata signature
    ) external returns (uint256 id) {
        if (embargo == 0 || embargo > MAX_EMBARGO) revert InvalidEmbargo();
        if (block.timestamp > deadline) revert Expired();
        if (signer == address(0)) revert InvalidSignature();
        if (strategyOf[signer] != 0) revert SignerAlreadyUsed();
        bytes32 digest =
            hashTypedData(keccak256(abi.encode(CREATE_TYPEHASH, embargo, metadataHash, deadline)));
        if (_recover(digest, signature) != signer) revert InvalidSignature();

        id = ++strategyCount;
        strategies[id] = Strategy(signer, embargo, 0, 0, metadataHash);
        strategyOf[signer] = id;
        emit StrategyCreated(id, signer, embargo, metadataHash);
    }

    /// @notice Records the next sealed commitment. The signature binds its sequence number, so a
    /// signed commitment can land only as that exact entry.
    function commit(uint256 id, bytes32 commitment, uint64 deadline, bytes calldata signature)
        external
        returns (uint64 seq)
    {
        Strategy storage s = _strategy(id);
        if (block.timestamp > deadline) revert Expired();
        seq = s.nextSeq;
        bytes32 digest =
            hashTypedData(keccak256(abi.encode(COMMIT_TYPEHASH, id, seq, commitment, deadline)));
        if (_recover(digest, signature) != s.signer) revert InvalidSignature();

        s.nextSeq = seq + 1;
        commits[id][seq] = Commit(commitment, uint64(block.timestamp));
        emit Committed(id, seq, commitment);
    }

    /// @notice Publishes the oldest unrevealed commitment after its embargo.
    function reveal(
        uint256 id,
        bytes32[] calldata assetIds,
        uint16[] calldata weightsBps,
        bytes32 salt
    ) external returns (uint64 seq) {
        Strategy storage s = _strategy(id);
        seq = s.nextRevealSeq;
        if (seq >= s.nextSeq) revert NothingToReveal();
        Commit storage c = commits[id][seq];
        if (block.timestamp < uint256(c.committedAt) + s.embargo) revert EmbargoActive();
        _checkBasket(assetIds, weightsBps);
        if (commitmentOf(id, seq, assetIds, weightsBps, salt) != c.commitment) {
            revert CommitmentMismatch();
        }

        s.nextRevealSeq = seq + 1;
        emit Revealed(id, seq, assetIds, weightsBps, salt);
    }

    /// @notice True when the oldest unrevealed commitment is past its embargo plus the grace period.
    function isBroken(uint256 id) external view returns (bool) {
        Strategy storage s = _strategy(id);
        if (s.nextRevealSeq == s.nextSeq) return false;
        Commit storage c = commits[id][s.nextRevealSeq];
        return block.timestamp > uint256(c.committedAt) + s.embargo + REVEAL_GRACE;
    }

    function strategy(uint256 id) external view returns (Strategy memory) {
        return _strategy(id);
    }

    function commitAt(uint256 id, uint64 seq) external view returns (Commit memory) {
        return commits[id][seq];
    }

    /// @notice keccak256(abi.encode(chainId, kind, token)); kind 0 is a token, 1 is a vault.
    function assetIdOf(uint64 chainId, uint8 kind, address token) external pure returns (bytes32) {
        return keccak256(abi.encode(chainId, kind, token));
    }

    /// @notice Every input is a 32-byte word, so the native signer hashes it without ABI tooling.
    function commitmentOf(
        uint256 id,
        uint64 seq,
        bytes32[] calldata assetIds,
        uint16[] calldata weightsBps,
        bytes32 salt
    ) public pure returns (bytes32) {
        // encodePacked pads each array element to 32 bytes.
        bytes32 assetsHash = keccak256(abi.encodePacked(assetIds));
        bytes32 weightsHash = keccak256(abi.encodePacked(weightsBps));
        return keccak256(abi.encode(id, seq, assetsHash, weightsHash, salt));
    }

    function domainSeparator() public view returns (bytes32) {
        return block.chainid == cachedChainId ? cachedDomainSeparator : _buildDomainSeparator();
    }

    function hashTypedData(bytes32 structHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function _strategy(uint256 id) private view returns (Strategy storage s) {
        s = strategies[id];
        if (s.signer == address(0)) revert UnknownStrategy();
    }

    /// @dev Sorted, unique asset ids; each weight a positive multiple of 5% and all summing to 100%.
    function _checkBasket(bytes32[] calldata assetIds, uint16[] calldata weightsBps) private pure {
        uint256 n = assetIds.length;
        if (n == 0 || n > MAX_ASSETS || weightsBps.length != n) revert InvalidBasket();
        uint256 total;
        for (uint256 i; i < n; ++i) {
            if (i > 0 && assetIds[i] <= assetIds[i - 1]) revert InvalidBasket();
            uint256 w = weightsBps[i];
            if (w == 0 || w % WEIGHT_STEP_BPS != 0) revert InvalidBasket();
            total += w;
        }
        if (total != TOTAL_BPS) revert InvalidBasket();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this))
        );
    }

    /// @dev 65-byte r || s || v signatures, v in {27, 28}, low s only.
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r = bytes32(signature[0:32]);
        bytes32 s = bytes32(signature[32:64]);
        uint8 v = uint8(signature[64]);
        if (uint256(s) > MAX_S || (v != 27 && v != 28)) revert InvalidSignature();
        address recovered = ecrecover(digest, v, r, s);
        if (recovered == address(0)) revert InvalidSignature();
        return recovered;
    }
}
