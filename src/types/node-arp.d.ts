declare module "node-arp" {
    function getMAC(ip: string, callback: (err: Error | null, mac: string | null) => void): void;

    export = {
        getMAC
    };
}
