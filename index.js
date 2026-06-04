const { metro } = vendetta;
const { after } = vendetta.patcher;

let unpatch;

export default {
    onLoad: () => {
        const GatewayConnection = metro.findByProps("getGatewayConnection", "isSessionReady");
        
        if (GatewayConnection) {
            unpatch = after("getGatewayConnection", GatewayConnection, (args, res) => {
                if (res && res.properties) {
                    res.properties["$os"] = "Windows";
                    res.properties["$browser"] = "Discord Client";
                    res.properties["$device"] = "discord-desktop";
                    res.properties["client_info"] = {
                        os: "Windows",
                        client: "desktop"
                    };
                }
                return res;
            });
        }
    },
    onUnload: () => {
        if (typeof unpatch === "function") unpatch();
    },
    settings: () => null
};
