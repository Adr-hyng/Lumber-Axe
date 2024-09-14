import { Block, BlockPermutation, EntityEquippableComponent, EquipmentSlot, ItemDurabilityComponent, ItemEnchantableComponent, ItemLockMode, ItemStack, Player, system, TicksPerSecond, world } from "@minecraft/server";
import { ActionFormData, ActionFormResponse, FormCancelationReason } from "@minecraft/server-ui";
import { axeEquipments, forceShow, getTreeLogs, InteractedTreeResult, isLogIncluded, playerInteractedTimeLogMap, playerInteractionMap, SendMessageTo, serverConfigurationCopy, stackDistribution, VisitedBlockResult } from "index"
import { MinecraftBlockTypes, MinecraftEnchantmentTypes } from "modules/vanilla-types/index";
import { Logger } from "utils/logger";

import "classes/player";
import { Graph } from "utils/graph";

// Improve in next update using runJob for caching, since caching still gets O(2n).

const blockOutlinesDespawnTimer = 10;

world.beforeEvents.worldInitialize.subscribe((registry) => {
  registry.itemComponentRegistry.registerCustomComponent('yn:tool_durability', {
    onHitEntity(arg) {
      if(!(arg.attackingEntity instanceof Player)) return;
      const player: Player = arg.attackingEntity;
      if(!player.isSurvival()) return;
      const axe = (player.getComponent(EntityEquippableComponent.componentId) as EntityEquippableComponent);
      axe.damageDurability(1);
    },
    async onMineBlock(arg) {
        if(!(arg.source instanceof Player)) return;
        const player: Player = arg.source;
        const axe = (player.getComponent(EntityEquippableComponent.componentId) as EntityEquippableComponent);
        const dimension = player.dimension;
        const blockInteracted = arg.block;
        const location = blockInteracted.location;
        const currentHeldAxe = arg.itemStack;
        const currentBreakBlock: BlockPermutation = arg.minedBlockPermutation;
        const blockTypeId: string = currentBreakBlock.type.id;
        if(!player.isSurvival()) return;
        if (!isLogIncluded(blockTypeId)) {
            axe.damageDurability(1);
            return;
        } 
        axe.damageDurability(2);
        const equipment = player.getComponent(EntityEquippableComponent.componentId) as EntityEquippableComponent;
        currentHeldAxe.lockMode = ItemLockMode.slot;
        
        const itemDurability: ItemDurabilityComponent = currentHeldAxe.getComponent(ItemDurabilityComponent.componentId) as ItemDurabilityComponent;
        const enchantments: ItemEnchantableComponent = (currentHeldAxe.getComponent(ItemEnchantableComponent.componentId) as ItemEnchantableComponent);
        const level: number = enchantments.getEnchantment(MinecraftEnchantmentTypes.Unbreaking)?.level | 0;
        const unbreakingMultiplier: number = (100 / (level + 1)) / 100;
        const unbreakingDamage: number = parseInt(serverConfigurationCopy.durabilityDamagePerBlock.defaultValue + "") * unbreakingMultiplier;
        let visited: Graph;
        
        // This should be the temporary container where it doesn't copy the reference from the original player's visitedNodes.
        let destroyedTree :InteractedTreeResult = {
            initialSize: 0,
            isDone: false,
            visitedLogs: {
                blockOutlines: [], 
                source: new Graph(),
                yOffsets: new Map()
            }
        };
        // Haven't used the cache for visual effect purposes :3
        const choppedTree = (await getTreeLogs(dimension, location, blockTypeId, (itemDurability.maxDurability - itemDurability.damage) / unbreakingDamage, false) as VisitedBlockResult);
        SendMessageTo(player, {rawtext: [{text: "Tree is fully traversed. "}]});
        destroyedTree.visitedLogs = choppedTree;
        visited = choppedTree.source;
        const size = visited.getSize() - 1;

        if(!visited) return;
        if(size <= 0) return;
        if(size >= parseInt(serverConfigurationCopy.chopLimit.defaultValue + "")) return resetOutlinedTrees(player, destroyedTree, true);
        //! Use this when fillBlocks is in stable. (Not applicable but can be good to be refactored to graph-based)
        // for (const group of groupAdjacentBlocks(visited)) {
        //     const firstElement = JSON.parse(group[0]);
        //     const lastElement = JSON.parse(group[group.length - 1]);
        //     if (firstElement === lastElement) {
        //         dimension.getBlock(firstElement).setType(MinecraftBlockTypes.Air);
        //         continue;
        //     } else {
        //         dimension.fillBlocks(firstElement, lastElement, MinecraftBlockTypes.Air);
        //     }
        // }

        await (new Promise<void>((resolve) => {
            const t = system.runJob((function*(){
                destroyedTree.visitedLogs.source.traverse(location, "BFS", (node) => {
                    if(node) {

                        // If there's setDestroy that cancels the dropped item, just use that instead of this.
                        const blockOutline = destroyedTree.visitedLogs.blockOutlines[node.index];
                        if(destroyedTree.visitedLogs.yOffsets.has(node.location.y) && destroyedTree.visitedLogs.yOffsets.get(node.location.y)) {
                            if(blockOutline?.isValid()) {
                                blockOutline.playAnimation('animation.block_outline.spawn_particle');
                                destroyedTree.visitedLogs.yOffsets.set(node.location.y, false);
                            }
                        }
                        system.waitTicks(3).then(()=>{
                            dimension.setBlockType(node.location, MinecraftBlockTypes.Air);
                        }); 
                    }
                });
                system.clearJob(t);
                resolve();
            })());
        })).then(() => {
            const totalDamage: number = size * unbreakingDamage;
            const postDamagedDurability: number = itemDurability.damage + totalDamage;
            if (postDamagedDurability + 1 === itemDurability.maxDurability) {
                equipment.setEquipment(EquipmentSlot.Mainhand, undefined);
            } else if (postDamagedDurability > itemDurability.maxDurability) {
                currentHeldAxe.lockMode = ItemLockMode.none;
                return; 
            } else if (postDamagedDurability < itemDurability.maxDurability){
                itemDurability.damage = itemDurability.damage +  totalDamage;
                currentHeldAxe.lockMode = ItemLockMode.none;
                equipment.setEquipment(EquipmentSlot.Mainhand, currentHeldAxe.clone());
            }
            for (const group of stackDistribution(size)) {
                system.run(() => dimension.spawnItem(new ItemStack(blockTypeId, group), location));
            }
        }).catch((e) => {
            console.warn(e, e.stack);
            currentHeldAxe.lockMode = ItemLockMode.none;
        });
    },
    async onUseOn(arg) {
        const currentHeldAxe: ItemStack = arg.itemStack;
        const blockInteracted: Block = arg.block;
        const player: Player = arg.source as Player;
        if (!axeEquipments.includes(currentHeldAxe.typeId) || !isLogIncluded(blockInteracted.typeId)) return;
        const oldLog = playerInteractedTimeLogMap.get(player.id);
        playerInteractedTimeLogMap.set(player.id, system.currentTick);
        if ((oldLog + 5) >= system.currentTick) return;
        const itemDurability: ItemDurabilityComponent = currentHeldAxe.getComponent(ItemDurabilityComponent.componentId) as ItemDurabilityComponent;
        const enchantments: ItemEnchantableComponent = (currentHeldAxe.getComponent(ItemEnchantableComponent.componentId) as ItemEnchantableComponent);
        const level: number = enchantments.getEnchantment(MinecraftEnchantmentTypes.Unbreaking)?.level | 0;
        const currentDurability = itemDurability.damage;
        const maxDurability = itemDurability.maxDurability;
        const unbreakingMultiplier: number = (100 / (level + 1)) / 100;
        const unbreakingDamage: number = parseInt(serverConfigurationCopy.durabilityDamagePerBlock.defaultValue + "") * unbreakingMultiplier;
        const reachableLogs = (maxDurability - currentDurability) / unbreakingDamage;

        const blockOutline = player.dimension.getEntities({closest: 1, maxDistance: 1, type: "yn:block_outline", location: blockInteracted.bottomCenter()})[0];
        
        try {
            // Check also, if this tree is already being interacted. By checking this current blockOutline (node), if it's being interacted.
            if(blockOutline?.isValid()) {
                let inspectedTree: InteractedTreeResult;
                if(!player.visitedLogs) return;
                const tempResult = await new Promise<{result: VisitedBlockResult, index: number}>((inspectTreePromiseResolve) => {
                    const tMain = system.runJob((function*(inspectTreePromiseResolve: (inspectedTreeResult: {result: VisitedBlockResult, index: number} | PromiseLike<{result: VisitedBlockResult, index: number}>) => void){

                        // Filter by getting the graph that has this node.
                        const possibleVisitedLogs: {result: InteractedTreeResult, index: number}[] = [];
                        for(let i = 0; i < player.visitedLogs.length; i++) {
                            const currentInspectedTree = player.visitedLogs[i];
                            const interactedTreeNode = currentInspectedTree.visitedLogs.source.getNode(blockInteracted.location);
                            if(interactedTreeNode) {
                                possibleVisitedLogs.push({result: currentInspectedTree, index: i});
                            }
                        }

                        if(!possibleVisitedLogs.length) return system.clearJob(tMain);

                        // After filtering check get that tree that this player has inspected, get the latest one.
                        const latestPossibleInspectedTree = possibleVisitedLogs[possibleVisitedLogs.length - 1];
                        const index = latestPossibleInspectedTree.index;
                        inspectedTree = latestPossibleInspectedTree.result;

                        if(!inspectedTree) return system.clearJob(tMain);
    
                        // Remove some nodes in the graph that is not existing anymore. So, it can update its branches or neighbors
                        for(const blockOutline of inspectedTree.visitedLogs.blockOutlines) {
                            if(!blockOutline?.isValid()) {
                                let {x, y, z} = blockOutline.lastLocation;
                                x -= 0.5;
                                z -= 0.5;
                                inspectedTree.visitedLogs.source.removeNode({x, y, z});
                            }
                            yield;
                        }

                        if(inspectedTree.initialSize === inspectedTree.visitedLogs.source.getSize()) {
                            system.clearJob(tMain);
                            inspectTreePromiseResolve({result: inspectedTree.visitedLogs, index: index});
                        }

                        const tempResult: VisitedBlockResult = {blockOutlines: [], source: new Graph(), yOffsets: new Map()};
    
                        // Traverse the interacted block to validate the remaining nodes, if something was removed. O(n)
                        for(const node of inspectedTree.visitedLogs.source.traverseIterative(blockInteracted.location, "BFS")) {
                            if(node) {
                                tempResult.blockOutlines.push(inspectedTree.visitedLogs.blockOutlines[node.index]);
                                tempResult.source.addNode(node);
                                tempResult.yOffsets.set(node.location.y, false);
                            }
                            yield;
                        }
                        system.clearJob(tMain);
                        inspectTreePromiseResolve({result: tempResult, index: index});
                    })(inspectTreePromiseResolve));
                });

                const newInspectedSubTree: InteractedTreeResult = {
                    initialSize: tempResult.result.source.getSize(),
                    isDone: false, 
                    visitedLogs: tempResult.result
                };
                
                // if this newly inspected tree is just the main inspected tree, then just update, else add this new result, since it has changed.
                const currentChangedIndex = player.visitedLogs.findIndex((result) => newInspectedSubTree.visitedLogs.source.isEqual(inspectedTree.visitedLogs.source) && !result.isDone);
                if(currentChangedIndex === -1) {
                    player.visitedLogs.push(newInspectedSubTree);
                    system.waitTicks(blockOutlinesDespawnTimer * TicksPerSecond).then(async (_) => {
                        if(!player.visitedLogs[tempResult.index]) return;
                        if(!player.visitedLogs[tempResult.index].isDone) resetOutlinedTrees(player, newInspectedSubTree);
                    });
                } else {
                    player.visitedLogs[tempResult.index] = newInspectedSubTree;
                }
                const size = tempResult.result.source.getSize();
                const totalDamage: number = size * unbreakingDamage;
                const totalDurabilityConsumed: number = currentDurability + totalDamage;
                console.warn(size, parseInt(serverConfigurationCopy.chopLimit.defaultValue + ""));
                const canBeChopped: boolean = ((totalDurabilityConsumed === maxDurability) || (totalDurabilityConsumed < maxDurability)) && (size <= parseInt(serverConfigurationCopy.chopLimit.defaultValue + ""));
                
                const inspectionForm: ActionFormData = new ActionFormData()
                .title({
                    rawtext: [
                    {
                        translate: "LumberAxe.form.title.text"
                    }
                    ]})
                .button(
                    {
                        rawtext: [
                        {
                            translate: `LumberAxe.form.treeSizeAbrev.text`
                        },
                        {
                            text: ` ${size !== 0 ? size : 1}${canBeChopped ? "" : "+" } `
                        },
                        {
                            translate: `LumberAxe.form.treeSizeAbrevLogs.text`
                        }
                    ]}, "textures/InfoUI/blocks.png")
                .button(
                    {
                        rawtext: [
                        {
                            translate: `LumberAxe.form.durabilityAbrev.text`
                        },
                        {
                            text: ` ${currentDurability}`
                        }
                    ]}, "textures/InfoUI/axe_durability.png")
                .button(
                    {
                        rawtext: [
                        {
                            translate: `LumberAxe.form.maxDurabilityAbrev.text`
                        },
                        {
                            text: ` ${maxDurability}`
                        }
                    ]}, "textures/InfoUI/required_durability.png")
                .button(
                    {
                        rawtext: [
                        {
                            text: "§l"
                        },
                        {
                            translate: `${canBeChopped ? "LumberAxe.form.canBeChopped.text": "LumberAxe.form.cannotBeChopped.text"}`
                        }
                    ]}, "textures/InfoUI/canBeCut.png");
                forceShow(player, inspectionForm).then((response: ActionFormResponse) => {
                    if(response.canceled || response.selection === undefined || response.cancelationReason === FormCancelationReason.UserClosed) {
                    return;
                }
                }).catch((error: Error) => {
                    Logger.error("Form Error: ", error, error.stack);
                });
            } else {
                const treeCollectedResult = await getTreeLogs(player.dimension, blockInteracted.location, blockInteracted.typeId, reachableLogs + 1);
                player.visitedLogs = player.visitedLogs ?? [];
                const result: InteractedTreeResult = {
                    visitedLogs: treeCollectedResult, 
                    isDone: false,
                    initialSize: treeCollectedResult.source.getSize(),
                };
                player.visitedLogs.push(result);
                system.runTimeout(async () => { 
                   if(!result.isDone) resetOutlinedTrees(player, result);
                }, blockOutlinesDespawnTimer * TicksPerSecond);
            }
        } catch (e) {
            console.warn(e, e.stack);
        }
    },
  })
});

/**
 * 
 * @param player Player
 * @param result Interacted Tree to despawn the block outlines later.
 * @param instantDespawn To instantly remove the outlines without shifting the visitedLogs.
 * @returns 
 */
function resetOutlinedTrees(player: Player, result: InteractedTreeResult, instantDespawn: boolean = false) {
    if(result.isDone) {
        return;    
    }
    result.isDone = true;
    if(!instantDespawn) player.visitedLogs?.shift();
    const t = system.runJob((function*(){
        for(const blockOutline of result.visitedLogs.blockOutlines) {
            if(blockOutline?.isValid()) {
                blockOutline.triggerEvent('despawn');
            }
            yield;
        }
        system.clearJob(t);
    })());
}