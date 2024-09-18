import { Block, EntityEquippableComponent, ItemCooldownComponent, ItemDurabilityComponent, ItemEnchantableComponent, ItemStack, MolangVariableMap, Player, system, TicksPerSecond, world } from "@minecraft/server";
import { ActionFormData, ActionFormResponse, FormCancelationReason } from "@minecraft/server-ui";
import { axeEquipments, forceShow, getTreeLogs, getTreeTrunkSize, InteractedTreeResult, isLogIncluded, playerInteractedTimeLogMap, resetOutlinedTrees, serverConfigurationCopy, VisitedBlockResult, visitedLogs} from "index"
import { MinecraftEnchantmentTypes } from "modules/vanilla-types/index";
import { Logger } from "utils/logger";

import "classes/player";
import { Graph } from "utils/graph";

world.beforeEvents.worldInitialize.subscribe((registry) => {
  registry.itemComponentRegistry.registerCustomComponent('yn:tool_durability', {
    onHitEntity(arg) {
      if(!(arg.attackingEntity instanceof Player)) return;
      const player: Player = arg.attackingEntity;
      if(!player.isSurvival()) return;
      const axe = (player.getComponent(EntityEquippableComponent.componentId) as EntityEquippableComponent);
      axe.damageDurability(1);
    },
    async onUseOn(arg) {
        const currentHeldAxe: ItemStack = arg.itemStack;
        const blockInteracted: Block = arg.block;
        const player: Player = arg.source as Player;
        if (!axeEquipments.includes(currentHeldAxe.typeId) || !isLogIncluded(blockInteracted.typeId)) return;
        const oldLog = playerInteractedTimeLogMap.get(player.id);
        playerInteractedTimeLogMap.set(player.id, system.currentTick);
        if ((oldLog + 5) >= system.currentTick) return;
        player.configuration.loadServer();
        const itemDurability: ItemDurabilityComponent = currentHeldAxe.getComponent(ItemDurabilityComponent.componentId) as ItemDurabilityComponent;
        const enchantments: ItemEnchantableComponent = (currentHeldAxe.getComponent(ItemEnchantableComponent.componentId) as ItemEnchantableComponent);
        const level: number = enchantments.getEnchantment(MinecraftEnchantmentTypes.Unbreaking)?.level | 0;
        const currentDurability = itemDurability.damage;
        const maxDurability = itemDurability.maxDurability;
        const unbreakingMultiplier: number = (100 / (level + 1)) / 100;
        const unbreakingDamage: number = parseInt(serverConfigurationCopy.durabilityDamagePerBlock.defaultValue + "") * unbreakingMultiplier;
        const reachableLogs = (maxDurability - currentDurability) / unbreakingDamage;

        const cooldown = (currentHeldAxe.getComponent(ItemCooldownComponent.componentId) as ItemCooldownComponent);
        let BLOCK_OUTLINES_DESPAWN_CD = cooldown.cooldownTicks / TicksPerSecond;
        try {
            // Check also, if this tree is already being interacted. By checking this current blockOutline (node), if it's being interacted.
            if(!visitedLogs) return;
            const tempResult = await new Promise<{result: VisitedBlockResult, index: number}>((inspectTreePromiseResolve) => {
                const tMain = system.runJob((function*(inspectTreePromiseResolve: (inspectedTreeResult: {result: VisitedBlockResult, index: number} | PromiseLike<{result: VisitedBlockResult, index: number}>) => void){
                    // Filter by getting the graph that has this node.
                    const possibleVisitedLogs: {result: InteractedTreeResult, index: number}[] = [];
                    for(let i = 0; i < visitedLogs.length; i++) {
                        const currentInspectedTree = visitedLogs[i];
                        const interactedTreeNode = currentInspectedTree.visitedLogs.source.getNode(blockInteracted);
                        if(interactedTreeNode) {
                            possibleVisitedLogs.push({result: currentInspectedTree, index: i});
                        }
                    }

                    if(!possibleVisitedLogs.length) {
                        inspectTreePromiseResolve({result: null, index: -1});
                        return system.clearJob(tMain);
                    }

                    // After filtering check get that tree that this player has inspected, get the latest one.
                    const latestPossibleInspectedTree = possibleVisitedLogs[possibleVisitedLogs.length - 1];
                    const index = latestPossibleInspectedTree.index;
                    const initialTreeInspection = latestPossibleInspectedTree.result;

                    if(initialTreeInspection.isBeingChopped) {
                        inspectTreePromiseResolve({result: null, index: -100});
                        return system.clearJob(tMain);
                    }

                    // Remove some nodes in the graph that is not existing anymore. So, it can update its branches or neighbors
                    for(const node of initialTreeInspection.visitedLogs.source.traverseIterative(blockInteracted, "BFS")) {
                        if(!node.block?.isValid() || !isLogIncluded(node.block.typeId)) {
                            initialTreeInspection.visitedLogs.source.removeNode(node.block);
                        }
                        yield;
                    }

                    if(initialTreeInspection.initialSize === initialTreeInspection.visitedLogs.source.getSize()) {
                        system.clearJob(tMain);
                        inspectTreePromiseResolve({result: initialTreeInspection.visitedLogs, index: index});
                    }

                    const finalizedTreeInspection: VisitedBlockResult = {
                        blockOutlines: [], 
                        source: new Graph(), 
                        yOffsets: new Map(),
                        trunk: {
                            center: {
                                x: 0,
                                z: 0
                            },
                            size: 0
                        }
                    };

                    // Traverse the interacted block to validate the remaining nodes, if something was removed. O(n)
                    for(const node of initialTreeInspection.visitedLogs.source.traverseIterative(blockInteracted, "BFS")) {
                        if(node.block?.isValid()) {
                            finalizedTreeInspection.blockOutlines.push(initialTreeInspection.visitedLogs.blockOutlines[node.index]);
                            finalizedTreeInspection.source.addNode(node);
                            finalizedTreeInspection.yOffsets.set(node.block.location.y, false);
                        }
                        yield;
                    }

                    // Just appending the sub-tree as a separate tree.
                    const newInspectedSubTree: InteractedTreeResult = {
                        isBeingChopped: false,
                        initialSize: finalizedTreeInspection.source.getSize(),
                        isDone: false, 
                        visitedLogs: finalizedTreeInspection
                    };
                    // if this newly inspected tree is just the main inspected tree, then just update, else add this new result, since it has changed.
                    const currentChangedIndex = visitedLogs.findIndex((result) => newInspectedSubTree.visitedLogs.source.isEqual(initialTreeInspection.visitedLogs.source) && !result.isDone);
                    if(currentChangedIndex === -1) {
                        if(newInspectedSubTree.initialSize > 0) visitedLogs.push(newInspectedSubTree);
                        system.waitTicks(BLOCK_OUTLINES_DESPAWN_CD * TicksPerSecond).then(async (_) => {
                            if(!visitedLogs[tempResult.index]) return;
                            if(!visitedLogs[tempResult.index].isDone) resetOutlinedTrees(newInspectedSubTree);
                        });
                    } else {
                        visitedLogs[tempResult.index] = newInspectedSubTree;
                    }
                    system.clearJob(tMain);
                    inspectTreePromiseResolve({result: finalizedTreeInspection, index: index});
                })(inspectTreePromiseResolve));
            });

            if(tempResult.index === -1) {
                if(cooldown.getCooldownTicksRemaining(player) !== 0) return;
                const molangVariable = new MolangVariableMap();
                // Get the bottom most log (TODO)
                let isTreeDoneTraversing = false;
                let treeOffsets: number[] = [];
                let result: InteractedTreeResult = {
                    isBeingChopped: false,
                    visitedLogs: { 
                        blockOutlines: [], 
                        source: new Graph(), 
                        trunk: {
                            center: { x: 0, z: 0},
                            size: 0
                        },
                        yOffsets: new Map()
                    }, 
                    isDone: false,
                    initialSize: 0,
                };
                // Instead of getting the center from all the available trunks, just make it so that
                // 1 = center of inteacted block
                // 2 - 4 = center of these 4 blocks
                // 5 - 9 = center of all of these 9 blocks.
                let interactedTreeTrunk = await getTreeTrunkSize(blockInteracted, blockInteracted.typeId);
                const topMostBlock = blockInteracted.dimension.getTopmostBlock(interactedTreeTrunk.center);
                const bottomMostBlock = await new Promise<Block>((getBottomMostBlockResolved) => {
                    let _bottom = blockInteracted.below();
                    const _t = system.runInterval(() => {
                        if(!isLogIncluded(blockInteracted.typeId) || blockInteracted.typeId !== _bottom.typeId) {
                            system.clearRun(_t);
                            getBottomMostBlockResolved(_bottom);
                            return;
                        }
                        _bottom = _bottom.below();
                    });
                });
                
                cooldown.startCooldown(player);
                const trunkSizeToParticleRadiusParser = {
                    1: 1.5,
                    2: 2.5,
                    3: 2.5,
                    4: 2.5,
                    5: 3.5,
                    6: 3.5,
                    7: 3.5,
                    8: 3.5,
                    9: 3.5
                }
                const trunkHeight = (topMostBlock.y - bottomMostBlock.y);
                const isValidVerticalTree = trunkHeight > 2;
                if(isValidVerticalTree) {
                    const it = system.runInterval(() => {
                        // Get the first block, and based on that it will get the height.
                        if(system.currentTick >= currentTime + (BLOCK_OUTLINES_DESPAWN_CD * TicksPerSecond) || result?.isDone) {
                            system.clearRun(it);
                            return;
                        }
                        if(isTreeDoneTraversing) {
                            molangVariable.setFloat('radius', trunkSizeToParticleRadiusParser[treeCollectedResult.trunk.size]);
                            molangVariable.setFloat('height', treeOffsets.length);
                            molangVariable.setFloat('max_age', 1);
                            molangVariable.setColorRGB('color', {red: 0.0, green: 1.0, blue: 0.0});
                        } else {
                            molangVariable.setFloat('radius', trunkSizeToParticleRadiusParser[interactedTreeTrunk.size]);
                            molangVariable.setFloat('height', trunkHeight);
                            molangVariable.setFloat('max_age', 1);
                            molangVariable.setColorRGB('color', {red: 1.0, green: 1.0, blue: 1.0}); // Change color based on property??
                        }
                        player.dimension.spawnParticle('yn:inspecting_indicator', {
                            x: interactedTreeTrunk.center.x, 
                            y: bottomMostBlock.y + 1, 
                            z: interactedTreeTrunk.center.z
                        }, molangVariable);
                    }, 5);
                }

                const currentTime = system.currentTick;
                const treeCollectedResult = await getTreeLogs(player.dimension, blockInteracted.location, blockInteracted.typeId, reachableLogs + 1);
                isTreeDoneTraversing = true;
                interactedTreeTrunk = treeCollectedResult.trunk;
                // (TODO) After traversing, align the center with the accurate one.
                console.warn(trunkHeight, isValidVerticalTree, topMostBlock.y, bottomMostBlock.y, interactedTreeTrunk.size);
                if(isValidVerticalTree) {
                    treeOffsets = Array.from(treeCollectedResult.yOffsets.keys()).sort((a, b) => a - b);
                } else {
                    const t = system.runJob((function*() {
                        for(const node of treeCollectedResult.source.traverseIterative(blockInteracted, "BFS")) {
                            molangVariable.setFloat('radius', 1.1);
                            molangVariable.setFloat('height', 0.99);
                            molangVariable.setFloat('max_age', BLOCK_OUTLINES_DESPAWN_CD);
                            molangVariable.setColorRGB('color', {red: 0.0, green: 1.0, blue: 0.0}); // Change color based on property??
                            player.dimension.spawnParticle('yn:inspecting_indicator', {x: node.block.bottomCenter().x, y: node.block.y, z: node.block.bottomCenter().z}, molangVariable);
                            yield;
                        }
                        system.clearJob(t);
                    })());
                }
                result = {
                    isBeingChopped: false,
                    visitedLogs: treeCollectedResult, 
                    isDone: false,
                    initialSize: treeCollectedResult.source.getSize(),
                };
                if(result.initialSize > 0) visitedLogs.push(result);
                system.runTimeout(() => { 
                    if(!result?.isDone) resetOutlinedTrees(result);
                }, (BLOCK_OUTLINES_DESPAWN_CD-2) * TicksPerSecond);
            } else if (tempResult.index >= 0) {
                const size = tempResult.result.source.getSize();
                const totalDamage: number = size * unbreakingDamage;
                const totalDurabilityConsumed: number = currentDurability + totalDamage;
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
            }
        } catch (e) {
            console.warn(e, e.stack);
        }
    },
  })
});