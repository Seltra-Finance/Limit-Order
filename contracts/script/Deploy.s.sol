// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {ISignatureTransfer} from "permit2/src/interfaces/ISignatureTransfer.sol";

import {SeltraSettlement} from "../src/SeltraSettlement.sol";
import {SeltraAggregationRouter} from "../src/SeltraAggregationRouter.sol";
import {MockDEXAdapter} from "../src/adapters/MockDEXAdapter.sol";
import {LFJLBAdapter} from "../src/adapters/LFJLBAdapter.sol";
import {BlackholeAdapter} from "../src/adapters/BlackholeAdapter.sol";
import {PharaohAdapter} from "../src/adapters/PharaohAdapter.sol";
import {ISeltraAggregationRouter} from "../src/interfaces/ISeltraAggregationRouter.sol";
import {ILBRouter} from "../src/interfaces/external/ILBRouter.sol";
import {ILBQuoter} from "../src/interfaces/external/ILBQuoter.sol";
import {IPharaohSwapRouter} from "../src/interfaces/external/IPharaohSwapRouter.sol";
import {IPharaohQuoterV2} from "../src/interfaces/external/IPharaohQuoterV2.sol";
import {IBlackholeRouterV2} from "../src/interfaces/external/IBlackholeRouterV2.sol";
import {IBlackholeRouterHelper} from "../src/interfaces/external/IBlackholeRouterHelper.sol";

interface ITokenPairPool {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface IMainnetTimelock {
    function getMinDelay() external view returns (uint256);
    function DEFAULT_ADMIN_ROLE() external view returns (bytes32);
    function PROPOSER_ROLE() external view returns (bytes32);
    function EXECUTOR_ROLE() external view returns (bytes32);
    function CANCELLER_ROLE() external view returns (bytes32);
    function hasRole(bytes32 role, address account) external view returns (bool);
}

interface IMainnetSafe {
    function getOwners() external view returns (address[] memory);
    function getThreshold() external view returns (uint256);
}

/// @notice Revised spec 1.11: one command deploys the full stack and writes
///         addresses.json. Fuji:
///
///   forge script script/Deploy.s.sol --rpc-url $FUJI_RPC_URL --broadcast --verify
///
/// Env:
///   DEPLOYER               expected deployer/signer address (required when
///                          PRIVATE_KEY is absent; recommended with --account)
///   PRIVATE_KEY            optional legacy signer input; never store in a file
///   OWNER                  final owner, multisig/timelock (default: deployer)
///   GUARDIAN               pause guardian (default: deployer)
///   LFJ_LB_ROUTER          LBRouter address (default: canonical v2.2, present
///                          on both Avalanche mainnet and Fuji)
///   LFJ_LB_QUOTER          LBQuoter address (default: canonical v2.2
///                          quoter; override on Fuji)
///   DEPLOY_MOCK_ADAPTER    default true; NEVER set on mainnet (spec 2.1)
///   DEPLOY_BLACKHOLE_ADAPTER default true on mainnet, false elsewhere
///   BLACKHOLE_ROUTER/HELPER and the four BLACKHOLE_*_POOL values default to
///                          the independently fork-validated mainnet contracts
///   PHARAOH_SWAP_ROUTER    immutable CL SwapRouter; zero skips adapter 3
///   PHARAOH_QUOTER_V2      CL QuoterV2; zero skips adapter 3
///   ALLOWED_TOKEN_0..9     tokens to allowlist at deploy time
///   ALLOWED_PAIR_0_A/B..9  unordered pairs to allowlist at deploy time
contract Deploy is Script {
    string constant BOOTSTRAP_EOA_ACK = "I_ACCEPT_SINGLE_EOA_GOVERNANCE_RISK";
    address constant CANONICAL_PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    uint8 constant MOCK_ADAPTER_ID = 0;
    uint8 constant LFJ_ADAPTER_ID = 1;
    uint8 constant BLACKHOLE_ADAPTER_ID = 2;
    uint8 constant PHARAOH_ADAPTER_ID = 3;

    address constant WAVAX = 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7;
    address constant USDC = 0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E;
    address constant USDT = 0x9702230A8Ea53601f5cD2dc00fDBc13d4dF4A8c7;
    address constant WETH_E = 0x49D5c2BdFfac6CE2BFdB6640F4F80f226bc10bAB;
    address constant BTC_B = 0x152b9d0FdC40C096757F570A51E494bd4b943E50;
    address constant LFJ_LB_ROUTER = 0x18556DA13313f3532c54711497A8FedAC273220E;
    address constant LFJ_LB_QUOTER = 0x9A550a522BBaDFB69019b0432800Ed17855A51C3;
    address constant BLACKHOLE_ROUTER = 0xe946A9f39312E2346BA79DAb865B0e9A74f2F981;
    address constant BLACKHOLE_HELPER = 0x53D569BC4B37ADbBDB6ab447D92ADf42514AE480;
    address constant BLACKHOLE_WAVAX_USDC_POOL = 0x41100C6D2c6920B10d12Cd8D59c8A9AA2eF56fC7;
    address constant BLACKHOLE_WETH_WAVAX_POOL = 0x5E128EbC09C918DDAE3Ca1668d4EE9527dc00D78;
    address constant BLACKHOLE_BTCB_WAVAX_POOL = 0x8FEF4fE4970a5D6bFa7C65871a2EbFD0F42aa822;
    address constant BLACKHOLE_USDC_USDT_POOL = 0x859592A4A469610E573f96Ef87A0e5565F9a94c8;
    address constant PHARAOH_SWAP_ROUTER = 0xc8B8fCbDb5C019D7802fFb0b39603395D7d3915c;
    address constant PHARAOH_QUOTER_V2 = 0xB7297301b7CC659BB96D51754643A0Df6eEA2138;

    struct DeploymentConfig {
        uint256 privateKey;
        address deployer;
        address owner;
        address guardian;
        address treasury;
        uint256 makerSurplusBps;
        uint256 protocolFeeBps;
        bool mainnet;
        bool deployMock;
        bool deployBlackhole;
        bool bootstrapEoaGovernance;
    }

    struct UpstreamConfig {
        address lbRouter;
        address lbQuoter;
        address pharaohRouter;
        address pharaohQuoter;
        address bhRouter;
        address bhHelper;
        address bhWavaxUsdcPool;
        address bhWethWavaxPool;
        address bhBtcbWavaxPool;
        address bhUsdcUsdtPool;
    }

    struct AdapterDeployments {
        address mock;
        address lfj;
        address blackhole;
        address pharaoh;
    }

    function run() external {
        DeploymentConfig memory config = _loadDeploymentConfig();
        UpstreamConfig memory upstream = _loadUpstreamConfig();
        _validateMainnetConfig(config, upstream);

        _startBroadcast(config.privateKey, config.deployer);
        address permit2 = _resolvePermit2();
        SeltraAggregationRouter router = new SeltraAggregationRouter(config.deployer, config.guardian);
        SeltraSettlement settlement = new SeltraSettlement(
            ISignatureTransfer(permit2), ISeltraAggregationRouter(address(router)), config.deployer, config.guardian
        );
        router.setSettlement(address(settlement));
        AdapterDeployments memory adapters = _deployAdapters(router, config, upstream);
        _configureSettlement(settlement, config);
        if (config.owner != config.deployer) {
            settlement.transferOwnership(config.owner);
            router.transferOwnership(config.owner);
        }
        vm.stopBroadcast();

        _writeManifest(config, upstream, permit2, settlement, router, adapters);
        console.log("Wrote addresses.json");
        console.log("Settlement:", address(settlement));
        console.log("Router:", address(router));
    }

    function _loadDeploymentConfig() internal view returns (DeploymentConfig memory config) {
        config.privateKey = vm.envOr("PRIVATE_KEY", uint256(0));
        if (config.privateKey == 0) {
            config.deployer = vm.envAddress("DEPLOYER");
        } else {
            config.deployer = vm.addr(config.privateKey);
            if (vm.envExists("DEPLOYER")) {
                require(vm.envAddress("DEPLOYER") == config.deployer, "PRIVATE_KEY does not match DEPLOYER");
            }
        }
        config.owner = vm.envOr("OWNER", config.deployer);
        config.guardian = vm.envOr("GUARDIAN", config.deployer);
        config.treasury = vm.envOr("TREASURY", address(0));
        config.makerSurplusBps = vm.envOr("MAKER_SURPLUS_BPS", uint256(7_000));
        config.protocolFeeBps = vm.envOr("PROTOCOL_FEE_BPS", uint256(0));
        config.mainnet = block.chainid == 43_114;
        config.deployMock = vm.envOr("DEPLOY_MOCK_ADAPTER", true);
        config.deployBlackhole = vm.envOr("DEPLOY_BLACKHOLE_ADAPTER", config.mainnet);
        config.bootstrapEoaGovernance = _bootstrapEoaAcknowledged();
        require(config.makerSurplusBps <= 10_000 && config.protocolFeeBps <= 1_000, "invalid fee bps");
        require(config.protocolFeeBps == 0 || config.treasury != address(0), "fee requires treasury");
    }

    function _loadUpstreamConfig() internal view returns (UpstreamConfig memory upstream) {
        upstream.lbRouter = vm.envOr("LFJ_LB_ROUTER", LFJ_LB_ROUTER);
        upstream.lbQuoter = vm.envOr("LFJ_LB_QUOTER", LFJ_LB_QUOTER);
        upstream.pharaohRouter = vm.envOr("PHARAOH_SWAP_ROUTER", PHARAOH_SWAP_ROUTER);
        upstream.pharaohQuoter = vm.envOr("PHARAOH_QUOTER_V2", PHARAOH_QUOTER_V2);
        upstream.bhRouter = vm.envOr("BLACKHOLE_ROUTER", BLACKHOLE_ROUTER);
        upstream.bhHelper = vm.envOr("BLACKHOLE_HELPER", BLACKHOLE_HELPER);
        upstream.bhWavaxUsdcPool = vm.envOr("BLACKHOLE_WAVAX_USDC_POOL", BLACKHOLE_WAVAX_USDC_POOL);
        upstream.bhWethWavaxPool = vm.envOr("BLACKHOLE_WETH_WAVAX_POOL", BLACKHOLE_WETH_WAVAX_POOL);
        upstream.bhBtcbWavaxPool = vm.envOr("BLACKHOLE_BTCB_WAVAX_POOL", BLACKHOLE_BTCB_WAVAX_POOL);
        upstream.bhUsdcUsdtPool = vm.envOr("BLACKHOLE_USDC_USDT_POOL", BLACKHOLE_USDC_USDT_POOL);
    }

    function _validateMainnetConfig(DeploymentConfig memory config, UpstreamConfig memory upstream) internal view {
        if (!config.mainnet) return;
        require(!config.deployMock, "mock adapter forbidden on Avalanche mainnet");
        require(config.deployBlackhole, "Blackhole adapter required on mainnet");
        require(
            config.owner != config.deployer && config.owner.code.length > 0, "mainnet OWNER must be a deployed timelock"
        );
        IMainnetTimelock timelock = IMainnetTimelock(config.owner);
        require(timelock.getMinDelay() >= 48 hours, "mainnet timelock delay below 48h");
        require(timelock.hasRole(timelock.PROPOSER_ROLE(), config.guardian), "guardian lacks proposer role");
        require(timelock.hasRole(timelock.EXECUTOR_ROLE(), config.guardian), "guardian lacks executor role");
        require(timelock.hasRole(timelock.CANCELLER_ROLE(), config.guardian), "guardian lacks canceller role");
        require(!timelock.hasRole(timelock.PROPOSER_ROLE(), address(0)), "timelock proposer role is open");
        require(!timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)), "timelock executor role is open");
        require(!timelock.hasRole(timelock.CANCELLER_ROLE(), address(0)), "timelock canceller role is open");
        require(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), config.owner), "timelock is not self-administered");
        require(
            !timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), config.guardian), "guardian has immediate timelock admin"
        );
        if (config.guardian.code.length == 0) {
            require(config.bootstrapEoaGovernance, "mainnet EOA guardian requires explicit risk acknowledgement");
            require(config.guardian == config.deployer, "bootstrap guardian must be deployer EOA");
        } else {
            require(!config.bootstrapEoaGovernance, "bootstrap acknowledgement set with Safe guardian");
            address[] memory safeOwners = IMainnetSafe(config.guardian).getOwners();
            uint256 safeThreshold = IMainnetSafe(config.guardian).getThreshold();
            require(safeThreshold >= 2 && safeOwners.length >= safeThreshold, "mainnet guardian Safe threshold too low");
        }
        require(CANONICAL_PERMIT2.code.length > 0, "canonical Permit2 missing on mainnet");
        require(upstream.lbRouter == LFJ_LB_ROUTER && upstream.lbQuoter == LFJ_LB_QUOTER, "unvalidated LFJ endpoint");
        require(
            upstream.pharaohRouter == PHARAOH_SWAP_ROUTER && upstream.pharaohQuoter == PHARAOH_QUOTER_V2,
            "unvalidated Pharaoh endpoint"
        );
        require(vm.envExists("MAKER_SURPLUS_BPS"), "mainnet MAKER_SURPLUS_BPS must be explicit");
        require(vm.envExists("PROTOCOL_FEE_BPS"), "mainnet PROTOCOL_FEE_BPS must be explicit");
        require(vm.envExists("TREASURY"), "mainnet TREASURY must be explicit");
        require(
            upstream.bhRouter == BLACKHOLE_ROUTER && upstream.bhHelper == BLACKHOLE_HELPER,
            "unvalidated Blackhole endpoint"
        );
        require(
            upstream.bhWavaxUsdcPool == BLACKHOLE_WAVAX_USDC_POOL
                && upstream.bhWethWavaxPool == BLACKHOLE_WETH_WAVAX_POOL
                && upstream.bhBtcbWavaxPool == BLACKHOLE_BTCB_WAVAX_POOL
                && upstream.bhUsdcUsdtPool == BLACKHOLE_USDC_USDT_POOL,
            "unvalidated Blackhole pool"
        );
    }

    function _resolvePermit2() internal returns (address permit2) {
        permit2 = CANONICAL_PERMIT2;
        if (permit2.code.length == 0) {
            bytes memory creationCode = vm.getCode("Permit2.sol:Permit2");
            assembly ("memory-safe") {
                permit2 := create(0, add(creationCode, 0x20), mload(creationCode))
            }
            require(permit2 != address(0), "Permit2 deploy failed");
            console.log("Canonical Permit2 absent; deployed local Permit2 at", permit2);
        }
    }

    function _deployAdapters(
        SeltraAggregationRouter router,
        DeploymentConfig memory config,
        UpstreamConfig memory upstream
    ) internal returns (AdapterDeployments memory deployed) {
        if (config.deployMock) {
            deployed.mock = address(new MockDEXAdapter(address(router), config.owner));
            router.addAdapter(MOCK_ADAPTER_ID, deployed.mock);
        }
        if (
            upstream.lbRouter != address(0) && upstream.lbQuoter != address(0) && upstream.lbRouter.code.length > 0
                && upstream.lbQuoter.code.length > 0
        ) {
            deployed.lfj = address(
                new LFJLBAdapter(address(router), ILBRouter(upstream.lbRouter), ILBQuoter(upstream.lbQuoter))
            );
            router.addAdapter(LFJ_ADAPTER_ID, deployed.lfj);
        } else {
            console.log("LFJ router/quoter unavailable; skipping adapter 1");
        }
        if (config.deployBlackhole) deployed.blackhole = _deployBlackhole(router, config, upstream);
        if (
            upstream.pharaohRouter != address(0) && upstream.pharaohQuoter != address(0)
                && upstream.pharaohRouter.code.length > 0 && upstream.pharaohQuoter.code.length > 0
        ) {
            deployed.pharaoh = address(
                new PharaohAdapter(
                    address(router),
                    IPharaohSwapRouter(upstream.pharaohRouter),
                    IPharaohQuoterV2(upstream.pharaohQuoter)
                )
            );
            router.addAdapter(PHARAOH_ADAPTER_ID, deployed.pharaoh);
        } else {
            console.log("Pharaoh router/quoter unavailable; skipping adapter 3");
        }
        if (config.mainnet) {
            require(
                deployed.lfj != address(0) && deployed.blackhole != address(0) && deployed.pharaoh != address(0),
                "venue missing"
            );
        }
    }

    function _deployBlackhole(
        SeltraAggregationRouter router,
        DeploymentConfig memory config,
        UpstreamConfig memory upstream
    ) internal returns (address deployed) {
        require(upstream.bhRouter.code.length > 0 && upstream.bhHelper.code.length > 0, "Blackhole unavailable");
        _validatePool(upstream.bhWavaxUsdcPool, WAVAX, USDC);
        _validatePool(upstream.bhWethWavaxPool, WETH_E, WAVAX);
        _validatePool(upstream.bhBtcbWavaxPool, BTC_B, WAVAX);
        _validatePool(upstream.bhUsdcUsdtPool, USDC, USDT);
        BlackholeAdapter adapter = new BlackholeAdapter(
            address(router),
            IBlackholeRouterV2(upstream.bhRouter),
            IBlackholeRouterHelper(upstream.bhHelper),
            config.deployer
        );
        adapter.setRouteAllowed(upstream.bhWavaxUsdcPool, WAVAX, USDC, false, true, true);
        adapter.setRouteAllowed(upstream.bhWavaxUsdcPool, USDC, WAVAX, false, true, true);
        adapter.setRouteAllowed(upstream.bhWethWavaxPool, WETH_E, WAVAX, false, true, true);
        adapter.setRouteAllowed(upstream.bhWethWavaxPool, WAVAX, WETH_E, false, true, true);
        adapter.setRouteAllowed(upstream.bhBtcbWavaxPool, BTC_B, WAVAX, false, true, true);
        adapter.setRouteAllowed(upstream.bhBtcbWavaxPool, WAVAX, BTC_B, false, true, true);
        adapter.setRouteAllowed(upstream.bhUsdcUsdtPool, USDC, USDT, false, true, true);
        adapter.setRouteAllowed(upstream.bhUsdcUsdtPool, USDT, USDC, false, true, true);
        if (config.owner != config.deployer) adapter.transferOwnership(config.owner);
        deployed = address(adapter);
        router.addAdapter(BLACKHOLE_ADAPTER_ID, deployed);
    }

    function _configureSettlement(SeltraSettlement settlement, DeploymentConfig memory config) internal {
        bool hasWavax;
        bool hasUsdc;
        bool hasUsdt;
        bool hasWeth;
        bool hasBtcb;
        for (uint256 i = 0; i < 10; i++) {
            address token = vm.envOr(string.concat("ALLOWED_TOKEN_", vm.toString(i)), address(0));
            if (token == address(0)) continue;
            if (config.mainnet) {
                require(
                    token == WAVAX || token == USDC || token == USDT || token == WETH_E || token == BTC_B,
                    "token outside launch registry"
                );
            }
            settlement.setTokenAllowed(token, true);
            if (token == WAVAX) hasWavax = true;
            if (token == USDC) hasUsdc = true;
            if (token == USDT) hasUsdt = true;
            if (token == WETH_E) hasWeth = true;
            if (token == BTC_B) hasBtcb = true;
        }
        if (config.mainnet) {
            require(hasWavax && hasUsdc && hasUsdt && hasWeth && hasBtcb, "mainnet launch tokens missing");
        }

        bool hasWavaxUsdc;
        bool hasWethWavax;
        bool hasBtcbWavax;
        bool hasUsdtUsdc;
        for (uint256 i = 0; i < 10; i++) {
            string memory suffix = vm.toString(i);
            address tokenA = vm.envOr(string.concat("ALLOWED_PAIR_", suffix, "_A"), address(0));
            address tokenB = vm.envOr(string.concat("ALLOWED_PAIR_", suffix, "_B"), address(0));
            require((tokenA == address(0)) == (tokenB == address(0)), "incomplete allowed pair");
            if (tokenA == address(0)) continue;

            bool wavaxUsdc = _samePair(tokenA, tokenB, WAVAX, USDC);
            bool wethWavax = _samePair(tokenA, tokenB, WETH_E, WAVAX);
            bool btcbWavax = _samePair(tokenA, tokenB, BTC_B, WAVAX);
            bool usdtUsdc = _samePair(tokenA, tokenB, USDT, USDC);
            if (config.mainnet) {
                require(wavaxUsdc || wethWavax || btcbWavax || usdtUsdc, "pair outside launch registry");
            }
            settlement.setPairAllowed(tokenA, tokenB, true);
            hasWavaxUsdc = hasWavaxUsdc || wavaxUsdc;
            hasWethWavax = hasWethWavax || wethWavax;
            hasBtcbWavax = hasBtcbWavax || btcbWavax;
            hasUsdtUsdc = hasUsdtUsdc || usdtUsdc;
        }
        if (config.mainnet) {
            require(hasWavaxUsdc && hasWethWavax && hasBtcbWavax && hasUsdtUsdc, "mainnet launch pairs missing");
        }
        settlement.setSurplusParams(uint16(config.makerSurplusBps), uint16(config.protocolFeeBps), config.treasury);
    }

    function _samePair(address tokenA, address tokenB, address expectedA, address expectedB)
        internal
        pure
        returns (bool)
    {
        return (tokenA == expectedA && tokenB == expectedB) || (tokenA == expectedB && tokenB == expectedA);
    }

    function _writeManifest(
        DeploymentConfig memory config,
        UpstreamConfig memory upstream,
        address permit2,
        SeltraSettlement settlement,
        SeltraAggregationRouter router,
        AdapterDeployments memory adapters
    ) internal {
        string memory json = "seltra";
        vm.serializeUint(json, "chainId", block.chainid);
        vm.serializeAddress(json, "permit2", permit2);
        vm.serializeAddress(json, "settlement", address(settlement));
        vm.serializeAddress(json, "router", address(router));
        vm.serializeAddress(json, "mockAdapter", adapters.mock);
        vm.serializeAddress(json, "lfjAdapter", adapters.lfj);
        vm.serializeAddress(json, "lfjRouter", upstream.lbRouter);
        vm.serializeAddress(json, "lfjQuoter", upstream.lbQuoter);
        vm.serializeAddress(json, "blackholeAdapter", adapters.blackhole);
        vm.serializeAddress(json, "blackholeRouter", upstream.bhRouter);
        vm.serializeAddress(json, "blackholeHelper", upstream.bhHelper);
        vm.serializeAddress(json, "blackholeWavaxUsdcPool", upstream.bhWavaxUsdcPool);
        vm.serializeAddress(json, "blackholeWethWavaxPool", upstream.bhWethWavaxPool);
        vm.serializeAddress(json, "blackholeBtcbWavaxPool", upstream.bhBtcbWavaxPool);
        vm.serializeAddress(json, "blackholeUsdcUsdtPool", upstream.bhUsdcUsdtPool);
        vm.serializeAddress(json, "pharaohAdapter", adapters.pharaoh);
        vm.serializeAddress(json, "pharaohRouter", upstream.pharaohRouter);
        vm.serializeAddress(json, "pharaohQuoter", upstream.pharaohQuoter);
        vm.serializeAddress(json, "wavax", WAVAX);
        vm.serializeAddress(json, "usdc", USDC);
        vm.serializeAddress(json, "usdt", USDT);
        vm.serializeAddress(json, "wethE", WETH_E);
        vm.serializeAddress(json, "btcB", BTC_B);
        vm.serializeUint(json, "makerSurplusBps", config.makerSurplusBps);
        vm.serializeUint(json, "protocolFeeBps", config.protocolFeeBps);
        vm.serializeAddress(json, "treasury", config.treasury);
        vm.serializeAddress(json, "owner", config.owner);
        vm.serializeAddress(json, "deployer", config.deployer);
        vm.serializeUint(json, "deploymentBlock", block.number);
        vm.serializeAddress(json, "guardian", config.guardian);
        string memory out = vm.serializeBool(json, "bootstrapEoaGovernance", config.bootstrapEoaGovernance);
        vm.writeJson(out, "./addresses.json");
    }

    function _bootstrapEoaAcknowledged() internal view returns (bool) {
        return
            keccak256(bytes(vm.envOr("BOOTSTRAP_EOA_GOVERNANCE_ACK", string(""))))
                == keccak256(bytes(BOOTSTRAP_EOA_ACK));
    }

    function _startBroadcast(uint256 privateKey, address deployer) internal {
        if (privateKey == 0) vm.startBroadcast(deployer);
        else vm.startBroadcast(privateKey);
    }

    function _validatePool(address pool, address tokenA, address tokenB) internal view {
        require(pool.code.length > 0, "Blackhole pool has no code");
        address token0 = ITokenPairPool(pool).token0();
        address token1 = ITokenPairPool(pool).token1();
        require(
            (token0 == tokenA && token1 == tokenB) || (token0 == tokenB && token1 == tokenA),
            "Blackhole pool token mismatch"
        );
    }
}
