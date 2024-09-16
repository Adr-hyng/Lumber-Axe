import { world, PlayerLeaveAfterEvent, ScriptEventCommandMessageAfterEvent, system, ScriptEventSource, Player, BlockPermutation, EntityEquippableComponent, EntityInventoryComponent, ItemDurabilityComponent, ItemEnchantableComponent, ItemLockMode, ItemStack, MolangVariableMap, PlayerBreakBlockBeforeEvent } from '@minecraft/server';
import { ADDON_IDENTIFIER, axeEquipments, getTreeLogs, InteractedTreeResult, isLogIncluded, playerInteractionMap, resetOutlinedTrees, SendMessageTo, serverConfigurationCopy, stackDistribution, VisitedBlockResult} from "./index"
import { Logger } from 'utils/logger';
import './items/axes';
import { MinecraftEnchantmentTypes, MinecraftBlockTypes } from 'modules/vanilla-types/index';
import { Graph } from 'utils/graph';

world.afterEvents.playerSpawn.subscribe((e) => {
    if(!e.initialSpawn) return;
    if(!serverConfigurationCopy.ShowMessageUponJoin.defaultValue) return; 
    SendMessageTo(e.player, {
        rawtext: [
        {
            translate: "LumberAxe.on_load_message"
        }
        ]
    });
});

world.afterEvents.playerLeave.subscribe((e: PlayerLeaveAfterEvent) => {
    playerInteractionMap.set(e.playerId, false);
}); 

world.beforeEvents.playerBreakBlock.subscribe((arg) => {
  const player: Player = arg.player;
  const axe = (player.getComponent(EntityEquippableComponent.componentId) as EntityEquippableComponent);
  const dimension = player.dimension;
  const blockInteracted = arg.block;
  const location = blockInteracted.location;
  const currentHeldAxe = arg.itemStack;
  const currentHeldAxeSlot = player.selectedSlotIndex;
  const currentBreakBlock: BlockPermutation = arg.block.permutation;
  const blockTypeId: string = currentBreakBlock.type.id;
  if(!axeEquipments.includes(currentHeldAxe.typeId)) return;
  if(!player.isSurvival()) return;
  if (!isLogIncluded(blockTypeId)) {
      system.run(() => axe.damageDurability(1));
      return;
  }
  system.run(async () => {
    currentHeldAxe.lockMode = ItemLockMode.slot;
    const inventory = (player.getComponent(EntityInventoryComponent.componentId) as EntityInventoryComponent).container;
    inventory.setItem(currentHeldAxeSlot, currentHeldAxe);
    axe.damageDurability(2);
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
        yOffsets: new Map(),
        trunk: {
            centroid: {
            x: 0, 
            z: 0
            }, 
            size: 0
        }
        }
    };
  
    // Use Cache again :,D 
    const choppedTree = (await getTreeLogs(dimension, location, blockTypeId, (itemDurability.maxDurability - itemDurability.damage) / unbreakingDamage, false) as VisitedBlockResult);
    SendMessageTo(player, {rawtext: [{text: "Tree is fully traversed. "}]});
    destroyedTree.visitedLogs = choppedTree;
    visited = choppedTree.source;
    const size = visited.getSize() - 1;
  
    if(!visited) return;
    if(size >= parseInt(serverConfigurationCopy.chopLimit.defaultValue + "")) return resetOutlinedTrees(destroyedTree, true);
    const totalDamage: number = size * unbreakingDamage;
    const postDamagedDurability: number = itemDurability.damage + totalDamage;
    if (postDamagedDurability + 1 === itemDurability.maxDurability) {
        player.playSound("random.break");
        inventory.setItem(currentHeldAxeSlot, undefined);
    } else if (postDamagedDurability > itemDurability.maxDurability) {
        currentHeldAxe.lockMode = ItemLockMode.none;
        return; 
    } 
    else if (postDamagedDurability < itemDurability.maxDurability){
        itemDurability.damage = itemDurability.damage +  totalDamage;
        const heldTemp = currentHeldAxe.clone();
        heldTemp.lockMode = ItemLockMode.none;
        inventory.setItem(currentHeldAxeSlot, heldTemp);
    }
    // Dust Particle (VFX)
    const trunkYCoordinates = Array.from(destroyedTree.visitedLogs.yOffsets.keys()).sort((a, b) => a - b);
    let currentBlockOffset = 0;
    const DustPerNumberOfBlocks = 2;
    if(<boolean>serverConfigurationCopy.progressiveChopping.defaultValue){
      for(const yOffset of trunkYCoordinates) {
          if(currentBlockOffset % DustPerNumberOfBlocks === 0) {
              await system.waitTicks(3);
              const molang = new MolangVariableMap();
              molang.setFloat('trunk_size', destroyedTree.visitedLogs.trunk.size);
              dimension.spawnParticle('yn:tree_dust', {x: destroyedTree.visitedLogs.trunk.centroid.x, y: yOffset, z: destroyedTree.visitedLogs.trunk.centroid.z}, molang);
          }
          destroyedTree.visitedLogs.yOffsets.set(yOffset, true);
          currentBlockOffset++;
      }
    }
    const t = system.runJob( (function* () {
      if(!(<boolean>serverConfigurationCopy.progressiveChopping.defaultValue)) {
        for(const yOffset of trunkYCoordinates) {
          if(currentBlockOffset % DustPerNumberOfBlocks === 0) {
              const molang = new MolangVariableMap();
              molang.setFloat('trunk_size', destroyedTree.visitedLogs.trunk.size);
              dimension.spawnParticle('yn:tree_dust', {x: destroyedTree.visitedLogs.trunk.centroid.x, y: yOffset, z: destroyedTree.visitedLogs.trunk.centroid.z}, molang);
          }
          destroyedTree.visitedLogs.yOffsets.set(yOffset, true);
          currentBlockOffset++;
          yield;
        }
      }
      for (const node of destroyedTree.visitedLogs.source.traverseIterative(blockInteracted, "BFS")) {
        if (node) {
          // If there's setDestroy that cancels the dropped item, just use that instead of this.
          // Custom Destroy Particle
          const blockOutline = destroyedTree.visitedLogs.blockOutlines[node.index];
          if (
            destroyedTree.visitedLogs.yOffsets.has(node.block.location.y) &&
            destroyedTree.visitedLogs.yOffsets.get(node.block.location.y)
          ) {
            if (blockOutline?.isValid()) {
              blockOutline.playAnimation('animation.block_outline.spawn_particle');
              destroyedTree.visitedLogs.yOffsets.set(node.block.location.y, false);
            }
          }
          system.waitTicks(3).then(() => dimension.setBlockType(node.block.location, MinecraftBlockTypes.Air));
        }
        yield;
      }

      for (const group of stackDistribution(size)) {
        dimension.spawnItem(new ItemStack(blockTypeId, group), location);
        yield;
      }
      system.clearJob(t);
    })());
  });
});

system.afterEvents.scriptEventReceive.subscribe((event: ScriptEventCommandMessageAfterEvent) => {
    if(event.sourceType !== ScriptEventSource.Entity) return;
    if(!(event.sourceEntity instanceof Player)) return;
    if(event.id !== ADDON_IDENTIFIER) return;
    const player = event.sourceEntity as Player;
    const message = event.message;
    const args = message.trim().split(/ +/g);
    const cmd = args.shift().toLowerCase();
    system.run(async () => {
      try {
          const {
            default: CommandObject
          } = await import(`./commands/${cmd}.js`);
          CommandObject.execute(player, args);
      } catch (err) {
        if (err instanceof ReferenceError) {
          SendMessageTo(player, {
            rawtext: [
              {
                translate: "yn:fishing_got_reel.on_caught_main_command_not_found",
                with: [
                  cmd,
                  "\n",
                  ADDON_IDENTIFIER
                ]
              }
            ]
          });
        } else {
          Logger.error(err, err.stack);
        }
      }
    });
});