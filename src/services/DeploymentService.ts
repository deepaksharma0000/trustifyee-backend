import { exec } from "child_process";
import util from "util";
import log from "../utils/logger";
import User from "../models/User";

const execPromise = util.promisify(exec);

/**
 * DEPLOYMENT SERVICE (Isolated Nodes)
 * 
 * Manages the lifecycle of per-user execution containers.
 */
export class DeploymentService {
    /**
     * Provision a dedicated execution node for a user
     * @param userId The ID of the user
     * @param staticIp The unique static IPv4 to be assigned to this container
     */
    static async provisionNode(userId: string, staticIp: string) {
        log.info(`[Deployment] Provisioning node for user ${userId} with IP ${staticIp}`);

        const containerName = `execution-node-${userId}`;
        
        try {
            // 1. Pull latest image (optional if local)
            // await execPromise("docker pull trustifye-execution-agent:latest");

            // 2. Run container with isolated networking
            // Note: We use --ip to bind to a specific static IP in a custom docker network
            const dockerCmd = `
                docker run -d \
                --name ${containerName} \
                --network algo-net \
                --ip ${staticIp} \
                -e USER_ID=${userId} \
                -e USER_STATIC_IP=${staticIp} \
                -e REDIS_HOST=redis-main \
                -e MONGO_URI=${process.env.MONGO_URI} \
                trustifye-execution-agent:latest
            `;

            const { stdout, stderr } = await execPromise(dockerCmd);
            
            if (stderr) log.warn(`[Deployment] Docker warning: ${stderr}`);
            
            log.info(`[Deployment] Node started: ${stdout.trim()}`);

            // 3. Update User record
            await User.findByIdAndUpdate(userId, {
                execution_node_id: stdout.trim(),
                outgoing_ip: staticIp,
                dedicated_ip_enabled: true
            });

            return { status: "SUCCESS", nodeId: stdout.trim() };

        } catch (err: any) {
            log.error(`[Deployment] Failed to provision node for ${userId}: ${err.message}`);
            throw err;
        }
    }

    /**
     * Stop and remove a user's execution node
     */
    static async decommissionNode(userId: string) {
        const containerName = `execution-node-${userId}`;
        try {
            await execPromise(`docker stop ${containerName} && docker rm ${containerName}`);
            await User.findByIdAndUpdate(userId, {
                execution_node_id: null,
                dedicated_ip_enabled: false
            });
            log.info(`[Deployment] Node decommissioned for ${userId}`);
        } catch (err: any) {
            log.error(`[Deployment] Failed to decommission node: ${err.message}`);
        }
    }
}
